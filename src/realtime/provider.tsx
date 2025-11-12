'use client'

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState
} from 'react'

import { createRealtimeSession } from '@/app/actions/realtime'

type RealtimeContextValue = {
	dataChannel: RTCDataChannel | null
	remoteStream: MediaStream | null
	start: (opts?: { instructions?: string; voice?: string; model?: string }) => Promise<void>
	updateInstructions: (text: string) => void
	updateVoice: (voice: string) => void
	stop: () => void
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null)

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
	const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
	const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null)
	const peerRef = useRef<RTCPeerConnection | null>(null)
	const localRef = useRef<MediaStream | null>(null)
	const trackMonitorCleanupRef = useRef<(() => void) | null>(null)
	const restartingMicRef = useRef(false)
	const restartAttemptsRef = useRef<{ since: number; count: number }>({ since: 0, count: 0 })
	const restartLocalStreamRef = useRef<(reason?: string) => Promise<void> | void>()

	const clearMonitor = useCallback(() => {
		trackMonitorCleanupRef.current?.()
		trackMonitorCleanupRef.current = null
	}, [])

	const attachTrackMonitors = useCallback((stream: MediaStream) => {
		clearMonitor()
		const [track] = stream.getAudioTracks()
		if (!track) return

		console.log('[realtime] monitoring microphone track', { id: track.id })

		const scheduleRestart = (reason: string) => {
			console.warn('[realtime] microphone track lost', { reason })
			try {
				restartLocalStreamRef.current?.(reason)
			} catch (error) {
				console.error('[realtime] mic restart handler threw', error)
			}
		}

		let muteTimer: ReturnType<typeof setTimeout> | null = null

		const handleEnded = () => scheduleRestart('track-ended')
		const handleMute = () => {
			if (!track.muted) return
			if (muteTimer) clearTimeout(muteTimer)
			muteTimer = setTimeout(() => {
				if (!track.muted) return
				scheduleRestart('track-muted')
			}, 650)
		}
		const handleUnmute = () => {
			if (!muteTimer) return
			clearTimeout(muteTimer)
			muteTimer = null
		}

		track.addEventListener('ended', handleEnded)
		track.addEventListener('mute', handleMute)
		track.addEventListener('unmute', handleUnmute)

		trackMonitorCleanupRef.current = () => {
			if (muteTimer) {
				clearTimeout(muteTimer)
				muteTimer = null
			}
			track.removeEventListener('ended', handleEnded)
			track.removeEventListener('mute', handleMute)
			track.removeEventListener('unmute', handleUnmute)
		}
	}, [clearMonitor])

	const restartLocalStream = useCallback(
		async (reason = 'unknown') => {
			if (!peerRef.current) {
				console.warn('[realtime] skipping microphone restart, no peer connection', { reason })
				return
			}
			if (restartingMicRef.current) {
				console.log('[realtime] microphone restart already running', { reason })
				return
			}

			const now = Date.now()
			const windowMs = 8_000
			if (now - restartAttemptsRef.current.since > windowMs) {
				restartAttemptsRef.current = { since: now, count: 0 }
			}
			if (restartAttemptsRef.current.count >= 3) {
				console.warn('[realtime] suppressing microphone restart, too many attempts', {
					reason
				})
				return
			}
			restartAttemptsRef.current.count += 1
			restartingMicRef.current = true

			try {
				console.log('[realtime] restarting microphone stream', { reason })
				const fresh = await navigator.mediaDevices.getUserMedia({ audio: true })
				attachTrackMonitors(fresh)
				const previous = localRef.current
				localRef.current = fresh
				const [track] = fresh.getAudioTracks()
				if (!track) throw new Error('Mic restart produced no audio track')
				const sender = peerRef.current
					.getSenders()
					.find(candidate => candidate.track?.kind === 'audio')
				if (sender) {
					await sender.replaceTrack(track)
					console.log('[realtime] replaced outbound audio track', { trackId: track.id })
				} else {
					peerRef.current.addTrack(track, fresh)
					console.log('[realtime] added outbound audio track after restart', {
						trackId: track.id
					})
				}
				for (const prevTrack of previous?.getTracks() ?? []) prevTrack.stop()
				restartAttemptsRef.current = { since: now, count: 0 }
			} catch (error) {
				console.error('[realtime] failed to restart microphone', error)
			} finally {
				restartingMicRef.current = false
			}
		},
		[attachTrackMonitors]
	)

	restartLocalStreamRef.current = restartLocalStream

	const cleanup = useCallback(() => {
		peerRef.current?.close()
		peerRef.current = null
		for (const track of localRef.current?.getTracks() ?? []) track.stop()
		localRef.current = null
		clearMonitor()
		restartingMicRef.current = false
		restartAttemptsRef.current = { since: 0, count: 0 }
		setRemoteStream(null)
		setDataChannel(null)
	}, [clearMonitor])

	const start = useCallback(
		async (opts?: { instructions?: string; voice?: string; model?: string }) => {
			console.log('[realtime] start() called', { opts })
			const session = await createRealtimeSession({
				instructions: opts?.instructions,
				model: opts?.model,
				voice: opts?.voice
			})
			const clientSecret = session.client_secret.value
			const model = session.model
			console.log('[realtime] created session', { expires_at: session.expires_at, model })

			const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
			console.log('[realtime] obtained microphone stream', {
				audioTracks: mic.getAudioTracks().length
			})
			localRef.current = mic
			attachTrackMonitors(mic)

			const pc = new RTCPeerConnection()
			peerRef.current = pc
			pc.addEventListener('icecandidate', e => {
				console.log('[realtime] icecandidate', { candidate: Boolean(e.candidate) })
			})
			pc.addEventListener('icegatheringstatechange', () => {
				console.log('[realtime] icegatheringstatechange', pc.iceGatheringState)
			})
			pc.addEventListener('signalingstatechange', () => {
				console.log('[realtime] signalingstatechange', pc.signalingState)
			})
			pc.addEventListener('connectionstatechange', () => {
				console.log('[realtime] connectionstatechange', pc.connectionState)
			})
			// Guard optional event for browsers that support it
			;(
				pc as unknown as { addEventListener?: (t: string, cb: (e: unknown) => void) => void }
			).addEventListener?.('icecandidateerror', (e: unknown) => {
				console.warn('[realtime] icecandidateerror', e)
			})

			pc.addEventListener('track', event => {
				const [first] = event.streams
				if (!first) return
				setRemoteStream(first)
				console.log('[realtime] remote track added', {
					kind: event.track.kind,
					remoteAudioTracks: first.getAudioTracks().length
				})
			})

			for (const track of mic.getTracks()) {
				pc.addTrack(track, mic)
			}

			const dc = pc.createDataChannel('oai-events')
			setDataChannel(dc)
			dc.addEventListener('open', () => {
				console.log('[realtime] datachannel open')
				try {
					if (opts?.voice || opts?.instructions) {
						dc.send(
							JSON.stringify({
								session: {
									...(opts?.voice ? { voice: opts.voice } : {}),
									...(opts?.instructions ? { instructions: opts.instructions } : {})
								},
								type: 'session.update'
							})
						)
						console.log('[realtime] sent session.update')
					}
				} catch {}
			})
			dc.addEventListener('close', () => {
				console.log('[realtime] datachannel close')
			})
			dc.addEventListener('message', e => {
				try {
					const msg = JSON.parse(String(e.data))
					console.log('[realtime] dc message', msg?.type ?? 'unknown', msg)
				} catch {
					console.log('[realtime] dc message (text)', String(e.data))
				}
			})

			const offer = await pc.createOffer()
			console.log('[realtime] created local offer', { sdpBytes: offer.sdp?.length ?? 0 })
			await pc.setLocalDescription(offer)
			console.log('[realtime] setLocalDescription')

			const resp = await fetch(
				`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
				{
					body: offer.sdp ?? '',
					headers: {
						Authorization: `Bearer ${clientSecret}`,
						'Content-Type': 'application/sdp',
						'OpenAI-Beta': 'realtime=v1'
					},
					method: 'POST'
				}
			)
			console.log('[realtime] handshake response', { status: resp.status })
			if (!resp.ok) {
				const body = await resp.text().catch(() => '')
				console.error('[realtime] handshake failed', resp.status, body)
				throw new Error(`Realtime handshake failed (${resp.status})`)
			}

			const answer = await resp.text()
			console.log('[realtime] received remote answer', { sdpBytes: answer.length })
			await pc.setRemoteDescription({ sdp: answer, type: 'answer' })
			console.log('[realtime] setRemoteDescription complete')
		},
		[]
	)

	const stop = useCallback(() => {
		console.log('[realtime] stop() called')
		cleanup()
	}, [cleanup])

	const updateInstructions = useCallback(
		(text: string) => {
			if (!dataChannel) return
			try {
				dataChannel.send(
					JSON.stringify({
						session: { instructions: text },
						type: 'session.update'
					})
				)
			} catch {
				// ignore
			}
		},
		[dataChannel]
	)

	const updateVoice = useCallback(
		(voice: string) => {
			if (!dataChannel) return
			try {
				dataChannel.send(
					JSON.stringify({
						session: { voice },
						type: 'session.update'
					})
				)
			} catch {
				// ignore
			}
		},
		[dataChannel]
	)

	const value = useMemo<RealtimeContextValue>(
		() => ({
			dataChannel,
			remoteStream,
			start,
			stop,
			updateInstructions,
			updateVoice
		}),
		[dataChannel, remoteStream, start, updateInstructions, updateVoice, stop]
	)

	useEffect(() => {
		if (typeof document === 'undefined') return
		const handleVisibility = () => {
			if (document.visibilityState !== 'visible') return
			const track = localRef.current?.getAudioTracks()[0]
			if (track && track.readyState === 'live') return
			void restartLocalStream('visibilitychange')
		}
		document.addEventListener('visibilitychange', handleVisibility)
		return () => document.removeEventListener('visibilitychange', handleVisibility)
	}, [restartLocalStream])

	useEffect(() => {
		if (typeof window === 'undefined') return
		const handlePageShow = (event: PageTransitionEvent) => {
			if (event.persisted) {
				void restartLocalStream('pageshow')
			}
		}
		window.addEventListener('pageshow', handlePageShow)
		return () => window.removeEventListener('pageshow', handlePageShow)
	}, [restartLocalStream])

	return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}

export function useRealtimeVoiceSession(): RealtimeContextValue {
	const ctx = useContext(RealtimeContext)
	if (!ctx) throw new Error('useRealtimeVoiceSession must be used within a RealtimeProvider')
	return ctx
}
