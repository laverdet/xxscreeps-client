import type { Schema } from './config';
import config from 'xxscreeps/config';
import os from 'os';
import JSZip from 'jszip';
import * as User from 'xxscreeps/engine/db/user';
import { hooks } from 'xxscreeps/backend';
import { promises as fs } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { Transform } from 'stream';

// Locate and read `package.nw`
const { data, stat } = await async function() {
	const fragment =
		(config as Schema).browserClient?.package ??
		(process.platform === 'win32' ? 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Screeps\\package.nw' :
		process.platform === 'darwin' ? './Library/Application Support/Steam/steamapps/common/Screeps/package.nw' : 'package.nw');
	const path = new URL(fragment, `${pathToFileURL(os.homedir())}/`);
	try {
		const [ data, stat ] = await Promise.all([
			fs.readFile(path),
			fs.stat(path),
		]);
		return { data, stat };
	} catch (err) {
		console.error(
			`@xxscreeps/client error: Could not read \`${fileURLToPath(path)}\`. ` +
			'Please set `browserClient.package` in `.screepsrc.yaml` to the full path of your package.nw file');
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

	hooks.register('middleware', koa => {

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
		// The client will just fill this up with data until the application breaks.
		if (localStorage['users.code.activeWorld']?.length > 1024 * 1024) {
			try {
				const code = JSON.parse(localStorage['users.code.activeWorld']);
				localStorage['users.code.activeWorld'] = JSON.stringify(code.sort((left, right) => right.timestamp - left.timestamp).slice(0, 2))
			} catch (err) {
				delete localStorage['users.code.activeWorld']
			}
		}
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
			const userId = function() {
				try {
					return context.state.userId;
				} catch (err) {}
			}();
			if (!userId) {
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
			}
			return next();
		});
	});
}
