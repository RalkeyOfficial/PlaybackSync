import type {
	Adapter,
	AdapterContext,
	AdapterFactory,
	LocalIntent,
	VideoState,
} from '../types'

/**
 * Baseline adapter. Activates only when the URL contains the query
 * parameter `pbsync-template`, so it stays inert on every real site. New
 * site adapters are forked from this file — match a real host in
 * `canHandlePage`, replace the identity-derivation in `init`, keep the
 * intent/command wiring as-is.
 */
class TemplateAdapter implements Adapter {
	readonly id = 'template'

	private video: HTMLVideoElement | null = null
	private ctx: AdapterContext | null = null
	private listeners: Array<[keyof HTMLMediaElementEventMap, () => void]> = []

	canHandlePage(url: URL): boolean {
		return url.searchParams.has('pbsync-template')
	}

	async init(ctx: AdapterContext): Promise<void> {
		this.ctx = ctx
		const video = document.querySelector('video')
		if (!video) {
			ctx.fail('no <video> element on page')
			return
		}
		this.video = video

		const emit = (type: LocalIntent['type']) => () => {
			ctx.emitIntent({ type, time: video.currentTime })
		}
		this.listeners = [
			['play', emit('play')],
			['pause', emit('pause')],
			['seeking', emit('seek')],
		]
		for (const [evt, fn] of this.listeners) {
			video.addEventListener(evt, fn)
		}

		ctx.onCommand((cmd) => {
			switch (cmd.type) {
				case 'play':
					void video.play()
					return
				case 'pause':
					video.pause()
					return
				case 'seek':
					video.currentTime = cmd.time
					return
				case 'nudge_rate':
					// The runtime intercepts `nudge_rate` before it reaches the
					// adapter and drives `setPlaybackRate` itself; this arm
					// exists only for switch exhaustiveness.
					return
				case 'cursor_change':
					// v2 navigation lands in the WS-client follow-up spec.
					return
			}
		})

		ctx.setIdentity({
			providerId: 'template',
			videoId: location.pathname,
			normalizedUrl: location.pathname,
		})
	}

	getState(): VideoState | null {
		const video = this.video
		if (!video) return null
		// HAVE_FUTURE_DATA = 3 — anything below means the next frame isn't
		// available yet, which is "actually buffering" rather than paused.
		const buffering = !video.paused && video.readyState < 3
		return {
			currentPos: video.currentTime,
			playerState: buffering ? 'buffering' : video.paused ? 'paused' : 'playing',
		}
	}

	setPlaybackRate(rate: number): void {
		if (this.video) this.video.playbackRate = rate
	}

	destroy(): void {
		if (this.video) {
			for (const [evt, fn] of this.listeners) {
				this.video.removeEventListener(evt, fn)
			}
		}
		this.listeners = []
		this.video = null
		this.ctx = null
	}
}

export const templateAdapterFactory: AdapterFactory = () => new TemplateAdapter()
