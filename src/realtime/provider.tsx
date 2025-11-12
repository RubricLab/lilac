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
	const lastStartOptsRef = useRef<{ instructions?: string; voice?: string; model?: string } | undefined>(
		undefined
	)
	const startInProgressRef = useRef(false)
	const restartingSessionRef = useRef(false)
	const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const startRef = useRef<RealtimeContextValue['start'] | null>(null)

	const cleanup = useCallback(() => {
		peerRef.current?.close()
		peerRef.current = null
		for (const track of localRef.current?.getTracks() ?? []) track.stop()
		localRef.current = null
		trackMonitorCleanupRef.current?.()
		trackMonitorCleanupRef.current = null
		if (restartTimerRef.current) {
			clearTimeout(restartTimerRef.current)
			restartTimerRef.current = null
		}
		setRemoteStream(null)
		setDataChannel(null)
	}, [])

	const scheduleSessionRestart = useCallback(
		(reason: string, delay = 300) => {
			if (!lastStartOptsRef.current) return
			if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
			restartTimerRef.current = setTimeout(async () => {
				restartTimerRef.current = null
				if (startInProgressRef.current || restartingSessionRef.current) {
					scheduleSessionRestart(reason, Math.min(delay * 2, 2000))
					return
				}
				const startFn = startRef.current
				if (!startFn) return
				try {
					restartingSessionRef.current = true
					console.warn('[realtime] restarting session', { reason, delay })
					cleanup()
					await startFn(lastStartOptsRef.current)
				} catch (error) {
					console.error('[realtime] session restart failed', error)
					scheduleSessionRestart('retry-after-failure', Math.min(delay * 2, 2000))
				} finally {
					restartingSessionRef.current = false
				}
			}, delay)
		},
		[cleanup]
	)

	const attachLocalTrackMonitor = useCallback(
		(stream: MediaStream) => {
			trackMonitorCleanupRef.current?.()
			trackMonitorCleanupRef.current = null
			const [track] = stream.getAudioTracks()
			if (!track) return

			console.log('[realtime] monitoring local microphone track', {
				id: track.id,
				label: track.label
			})

			let mutedTimer: ReturnType<typeof setTimeout> | null = null
			const flushMutedTimer = () => {
				if (mutedTimer) {
					clearTimeout(mutedTimer)
					mutedTimer = null
				}
			}

			const handleTrackLost = (reason: string) => {
				console.warn('[realtime] microphone track inactive', { reason, id: track.id })
				flushMutedTimer()
				scheduleSessionRestart(reason, reason === 'ended' ? 150 : 400)
			}

			const handleEnded = () => handleTrackLost('ended')
			const handleMute = () => {
				if (!track.muted) return
				flushMutedTimer()
				mutedTimer = setTimeout(() => {
					if (track.muted) handleTrackLost('mute-timeout')
				}, 600)
			}
			const handleUnmute = () => flushMutedTimer()

			track.addEventListener('ended', handleEnded)
			track.addEventListener('mute', handleMute)
			track.addEventListener('unmute', handleUnmute)

			const healthInterval = setInterval(() => {
				if (track.readyState !== 'live') {
					handleTrackLost(`state-${track.readyState}`)
				}
			}, 1200)

			trackMonitorCleanupRef.current = () => {
				flushMutedTimer()
				clearInterval(healthInterval)
				track.removeEventListener('ended', handleEnded)
				track.removeEventListener('mute', handleMute)
				track.removeEventListener('unmute', handleUnmute)
			}
		},
		[scheduleSessionRestart]
	)

	const start = useCallback(
		async (opts?: { instructions?: string; voice?: string; model?: string }) => {
			if (startInProgressRef.current) {
				console.log('[realtime] start() ignored, already in progress')
				return
			}
			startInProgressRef.current = true
			console.log('[realtime] start() called', { opts })
			lastStartOptsRef.current = opts
			try {
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
				attachLocalTrackMonitor(mic)

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
					if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
						scheduleSessionRestart(`connection-${pc.connectionState}`, 400)
					} else if (pc.connectionState === 'disconnected') {
						scheduleSessionRestart('connection-disconnected', 900)
					}
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
					first.addEventListener(
						'removetrack',
						() => scheduleSessionRestart('remote-track-removed', 600),
						{ once: true }
					)
				})

				for (const track of mic.getTracks()) {
					pc.addTrack(track, mic)
				}

				const dc = pc.createDataChannel('oai-events')
				setDataChannel(dc)
				dc.addEventListener('open', () => {
					console.log('[realtime] datachannel open')
					// Ensure session settings (voice/instructions) are applied then trigger a first response.
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
					try {
						dc.send(
							JSON.stringify({
								response: {
									// If instructions provided, model may greet appropriately; otherwise send a short greeting.
									...(opts?.instructions ? {} : { instructions: 'Hello! I am ready to translate.' })
								},
								type: 'response.create'
							})
						)
						console.log('[realtime] sent response.create')
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
			} catch (error) {
				console.error('[realtime] start() failed', error)
				cleanup()
				throw error
			} finally {
				startInProgressRef.current = false
			}
		},
		[attachLocalTrackMonitor, cleanup, scheduleSessionRestart]
	)

	useEffect(() => {
		startRef.current = start
		return () => {
			startRef.current = null
		}
	}, [start])

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
			if (track && track.readyState === 'live' && !track.muted) return
			scheduleSessionRestart('visibility-resume', 250)
		}
		document.addEventListener('visibilitychange', handleVisibility)
		return () => document.removeEventListener('visibilitychange', handleVisibility)
	}, [scheduleSessionRestart])

	useEffect(() => {
		if (typeof window === 'undefined') return
		const handlePageShow = (event: PageTransitionEvent) => {
			if (event.persisted) {
				scheduleSessionRestart('pageshow-persisted', 250)
			}
		}
		window.addEventListener('pageshow', handlePageShow)
		const handleFocus = () => {
			const track = localRef.current?.getAudioTracks()[0]
			if (track && track.readyState === 'live') return
			scheduleSessionRestart('window-focus', 400)
		}
		window.addEventListener('focus', handleFocus)
		return () => {
			window.removeEventListener('pageshow', handlePageShow)
			window.removeEventListener('focus', handleFocus)
		}
	}, [scheduleSessionRestart])

	return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}

export function useRealtimeVoiceSession(): RealtimeContextValue {
	const ctx = useContext(RealtimeContext)
	if (!ctx) throw new Error('useRealtimeVoiceSession must be used within a RealtimeProvider')
	return ctx
}
