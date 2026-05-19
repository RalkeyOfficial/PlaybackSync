export default defineContentScript({
	matches: [
		'https://www.miruro.tv/*',
		'https://www.miruro.to/*',
	],
	runAt: 'document_idle',
	main() {
		console.log('[playbacksync] content script loaded on', location.href);
	},
});
