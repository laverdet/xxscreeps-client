export type Schema = {
	/**
	 * Configuration for '@xxscreeps/client'
	 */
	browserClient?: {
		/**
		 * Full path to `package.nw`. This has the following defaults:
		 * macOS: ~/Library/Application Support/Steam/steamapps/common/Screeps/package.nw
		 * Windows: C:\Program Files (x86)\Steam\steamapps\common\Screeps\package.nw
		 */
		package?: string;
	};
};