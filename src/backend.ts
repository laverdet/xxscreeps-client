import config from 'xxscreeps/config';
import passport from 'koa-passport';
import os from 'os';
import Router from 'koa-router';
import JSZip from 'jszip';
import * as Crypto from 'crypto';
import * as User from 'xxscreeps/engine/db/user';
import { promises as fs } from 'fs';
import { pathToFileURL } from 'url';
import { Transform } from 'stream';
import { Strategy as SteamStrategy } from 'passport-steam';
import { registerBackendMiddleware } from 'xxscreeps/backend';

// Locate and read `package.nw`
const { data, stat } = await async function() {
	const fragment =
		process.platform === 'win32' ? 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Screeps\\package.nw' :
		process.platform === 'darwin' ? './Library/Application Support/Steam/steamapps/common/Screeps/package.nw' : undefined;
	if (fragment) {
		const path = new URL(fragment, `${pathToFileURL(os.homedir())}/`);
		try {
			const [ data, stat ] = await Promise.all([
				 fs.readFile(path),
				fs.stat(path),
			]);
			return { data, stat };
		} catch (err) {
			console.error(`Could not read: ${path}`);
		}
	} else {
		console.error(`Unknown platform ${process.platform}. Please locate your \`package.nw\` file and tell the author where it is`);
	}
	return {};
}();

if (data) {
	// Read package zip metadata
	const zip = new JSZip;
	await zip.loadAsync(data);
	const { files } = zip;
	// HTTP header is only accurate to the minute
	const lastModified = Math.floor(+stat!.mtime / 60000) * 60000;

	registerBackendMiddleware((koa, router) => {
		// Grab hostname for use in Passport
		let host: string | undefined;
		koa.use((context, next) => {
			host = context.request.origin;
			return next();
		});

		// Serve client assets directly from steam package
		koa.use(async(context, next) => {
			const path = context.request.path === '/' ?
				'index.html' : context.request.path.substr(1);
			const file = files[path];
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			if (!file) {
				return next();
			}

			// Check cached response based on zip file modification
			if (+new Date(context.request.headers['if-modified-since']!) >= lastModified) {
				context.status = 304;
				return;
			}

			context.body = await async function() {
				if (path === 'index.html') {
					let body = await file.async('text');
					// Inject startup shim
					const header = '<title>Screeps</title>';
					body = body.replace(header, `<script>
		if (
			(localStorage.auth === 'null' && localStorage.prevAuth === 'null') ||
			!(Date.now() - localStorage.lastToken < 2 * 60000) ||
			(localStorage.prevAuth !== '"guest"' && (localStorage.auth === 'null' || !localStorage.auth))
		) {
			localStorage.auth = '"guest"';
		}
		localStorage.tutorialVisited = 'true';
		localStorage.placeSpawnTutorialAsked = '1';
		localStorage.prevAuth = localStorage.auth;
		localStorage.lastToken = Date.now();
		(function() {
			let auth = localStorage.auth;
			setInterval(() => {
				if (auth !== localStorage.auth) {
					auth = localStorage.auth;
					localStorage.lastToken = Date.now();
				}
			}, 1000);
		})();
		addEventListener('beforeunload', () => {
			if (localStorage.auth === 'null') {
				document.cookie = 'id=';
				document.cookie = 'session=';
			}
		});
					</script>` + header);
					// Remove tracking pixels
					body = body.replace(/<script[^>]*>[^>]*xsolla[^>]*<\/script>/g, '');
					body = body.replace(/<script[^>]*>[^>]*facebook[^>]*<\/script>/g, '<script>fbq = new Proxy(() => fbq, { get: () => fbq })</script>');
					body = body.replace(/<script[^>]*>[^>]*google[^>]*<\/script>/g, '<script>ga = new Proxy(() => ga, { get: () => ga })</script>');
					body = body.replace(/<script[^>]*>[^>]*mxpnl[^>]*<\/script>/g, '<script>mixpanel = new Proxy(() => mixpanel, { get: () => mixpanel })</script>');
					body = body.replace(/<script[^>]*>[^>]*twttr[^>]*<\/script>/g, '<script>twttr = new Proxy(() => twttr, { get: () => twttr })</script>');
					body = body.replace(/<script[^>]*>[^>]*onRecaptchaLoad[^>]*<\/script>/g, '<script>function onRecaptchaLoad(){}</script>');
					return body;
				} else if (path === 'config.js') {
					return `
						var HISTORY_URL = undefined;
						var API_URL = '/api/';
						var WEBSOCKET_URL = '/socket/';
						var CONFIG = {
							API_URL: API_URL,
							HISTORY_URL: HISTORY_URL,
							WEBSOCKET_URL: WEBSOCKET_URL,
							PREFIX: '',
							IS_PTR: false,
							DEBUG: false,
							XSOLLA_SANDBOX: false,
						};
					`;
				} else if (path === 'build.min.js') {
					// Replace official CDN with local assets
					const content = await file.async('text');
					return content.replace(/https:\/\/d3os7yery2usni\.cloudfront\.net\//g, '/assets/');
				} else {
					// JSZip doesn't implement their read stream correctly and it causes EPIPE crashes. Pass it
					// through a no-op transform stream first to iron that out.
					const stream = new Transform;
					stream._transform = function(chunk, encoding, done) {
						this.push(chunk, encoding);
						done();
					};
					file.nodeStream().pipe(stream);
					return stream;
				}
			}();

			// Set content type
			context.set('Content-Type', {
				'.css': 'text/css',
				'.html': 'text/html',
				'.js': 'text/javascript',
				'.map': 'application/json',
				'.png': 'image/png',
				'.svg': 'image/svg+xml',
				'.ttf': 'font/ttf',
				'.woff': 'font/woff',
				'.woff2': 'font/woff2',
			}[/\.[^.]+$/.exec(path.toLowerCase())?.[0] ?? '.html']!);

			// We can safely cache explicitly-versioned resources forever
			if (context.request.query.bust) {
				context.set('Cache-Control', 'public,max-age=31536000,immutable');
			}
			context.set('Last-Modified', `${new Date(lastModified)}`);

			// Don't send any auth tokens for these requests
			context.state.token = false;
		});

		// Authenticate from cookie
		koa.use(async(context, next) => {
			try {
				if (context.state.userId) {
					return await next();
				}
			} catch (err) {}
			const id = context.cookies.get('id');
			if (id) {
				const sessionId = await context.db.data.hget(User.infoKey(id), 'session');
				if (context.cookies.get('session') === sessionId) {
					context.state.userId = id;
				} else {
					context.cookies.set('id');
					context.cookies.set('session');
				}
			}
			return next();
		});

		// Set up passport
		passport.use('steam', new SteamStrategy({
			apiKey: config.backend.steamApiKey,
			profile: false,
			// Dynamic `returnURL` and `realm` provided by this awesome patch
			// https://github.com/passport-next/passport-openid/pull/3#issuecomment-632860051
			returnURL: () => `${host}/api/auth/steam/return`,
			realm: () => host,
		}, (identifier: string, profile: unknown, done: (err: null | Error, value?: string) => void) => {
			const steamId = /https:\/\/steamcommunity.com\/openid\/id\/(?<id>[^/]+)/.exec(identifier)?.groups!.id;
			done(null, steamId);
		}));

		// `/api/auth/steam` endpoints
		const steam = new Router;
		steam.get('/');
		steam.all('/return', async context => {
			const steamid = context.state.user;
			await context.authenticateForProvider('steam', steamid);
			const token = await context.flushToken();
			const { userId } = context.state;
			const username = await async function() {
				if (userId !== undefined) {
					const key = User.infoKey(userId);
					const sessionId = Crypto.randomBytes(16).toString('hex');
					const [ username ] = await Promise.all([
						context.db.data.hget(key, 'username'),
						context.db.data.hset(key, 'session', sessionId),
					]);
					context.cookies.set('id', userId, { httpOnly: false });
					context.cookies.set('session', sessionId, { httpOnly: false });
					return username;
				}
			}();
			const json = JSON.stringify(JSON.stringify({ steamid, token, username }));
			context.body = `<html><body><script type="text/javascript">
				opener.postMessage(${json}, '*');
				setTimeout(() => {
					opener.location.replace("/#!/map/shard0");
					opener.location.reload();
					window.close();
				}, 100);
			</script></body>`;
		});

		// Plug steam router into koa backend
		router.use('/api/auth/steam',
			passport.initialize(),
			passport.authenticate('steam', {
				session: false,
				failureRedirect: '/',
			}),
			steam.routes(), steam.allowedMethods());
	});
}
