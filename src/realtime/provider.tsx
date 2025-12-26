'use client'

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

import { createRealtimeSession } from '@/app/actions/realtime'

export type RealtimeTranscriptMessage = {
	/** Stable id tied to the underlying Realtime item/response. */
	id: string
	role: 'user' | 'assistant'
	text: string
	status: 'streaming' | 'final'
	/**
	 * Where this text came from.
	 * - input_transcription: user audio transcription
	 * - response_text: assistant text stream
	 * - response_audio_transcript: assistant audio transcript stream
	 */
	source: 'input_transcription' | 'input_text' | 'response_text' | 'response_audio_transcript'
}

type RealtimeContextValue = {
	dataChannel: RTCDataChannel | null
	remoteStream: MediaStream | null
	transcripts: RealtimeTranscriptMessage[]
	start: (opts?: { instructions?: string; voice?: string; model?: string }) => Promise<void>
	updateInstructions: (text: string) => void
	updateVoice: (voice: string) => void
	updateTurnDelaySeconds: (seconds: number) => void
	updateSpeechEnabled: (enabled: boolean) => void
	updateMicEnabled: (enabled: boolean) => void
	sendText: (text: string) => boolean
	clearTranscripts: () => void
	stop: () => void
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null)

const turnDelayStorageKey = 'lilac.turnDelaySeconds'
const defaultTurnDelaySeconds = 1.2

function normalizeTurnDelaySeconds(value: unknown): number | null {
	const asNumber = typeof value === 'number' ? value : Number.parseFloat(String(value))
	if (!Number.isFinite(asNumber)) return null
	const clamped = Math.min(6, Math.max(0.2, asNumber))
	return Math.round(clamped * 10) / 10
}

function getInitialTurnDelaySeconds(): number {
	if (typeof window === 'undefined') return defaultTurnDelaySeconds
	const stored = window.localStorage.getItem(turnDelayStorageKey)
	const normalized = stored === null ? null : normalizeTurnDelaySeconds(stored)
	return normalized ?? defaultTurnDelaySeconds
}

function orderTranscriptsByPreviousItemId(
	list: RealtimeTranscriptMessage[],
	previousItemIdById: Map<string, string | null>
): RealtimeTranscriptMessage[] {
	if (list.length <= 1) return list

	const byId = new Map(list.map(item => [item.id, item] as const))
	const ids = list.map(item => item.id)
	const originalIndex = new Map(ids.map((id, idx) => [id, idx] as const))

	const prevById = new Map<string, string | null | undefined>()
	for (const id of ids) {
		if (previousItemIdById.has(id)) prevById.set(id, previousItemIdById.get(id) ?? null)
		else prevById.set(id, undefined)
	}

	const childrenByPrev = new Map<string, string[]>()
	const ROOT = '__root__'

	for (const id of ids) {
		const prev = prevById.get(id)
		if (prev === undefined) continue
		const key = prev ?? ROOT
		const arr = childrenByPrev.get(key) ?? []
		arr.push(id)
		childrenByPrev.set(key, arr)
	}

	childrenByPrev.forEach((arr, key) => {
		arr.sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0))
		childrenByPrev.set(key, arr)
	})

	const visited = new Set<string>()
	const out: string[] = []

	const visit = (id: string) => {
		if (visited.has(id)) return
		visited.add(id)
		out.push(id)
		const kids = childrenByPrev.get(id)
		if (!kids) return
		for (const kid of kids) visit(kid)
	}

	const roots: string[] = []
	for (const id of ids) {
		const prev = prevById.get(id)
		if (prev === undefined) continue
		if (prev === null || (typeof prev === 'string' && !byId.has(prev))) roots.push(id)
	}

	roots.sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0))
	for (const root of roots) visit(root)

	const remaining = ids.filter(id => !visited.has(id))
	remaining.sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0))
	for (const id of remaining) visit(id)

	const ordered = out.map(id => byId.get(id)).filter(Boolean) as RealtimeTranscriptMessage[]

	let unchanged = ordered.length === list.length
	if (unchanged) {
		for (let i = 0; i < ordered.length; i += 1) {
			if (ordered[i]?.id !== list[i]?.id) {
				unchanged = false
				break
			}
		}
	}

	return unchanged ? list : ordered
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
	const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
	const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null)
	const [transcripts, setTranscripts] = useState<RealtimeTranscriptMessage[]>([])
	const peerRef = useRef<RTCPeerConnection | null>(null)
	const localRef = useRef<MediaStream | null>(null)
	const turnDelaySecondsRef = useRef<number>(getInitialTurnDelaySeconds())
	// Cancels in-flight `start()` calls and prevents multiple concurrent sessions.
	const startGenerationRef = useRef(0)
	// Stable transcript item id we choose for a given response_id (so we don't "split" a message mid-stream).
	const assistantMessageIdByResponseIdRef = useRef<Map<string, string>>(new Map())
	const assistantPreferredSourceByIdRef = useRef<
		Map<string, 'response_text' | 'response_audio_transcript'>
	>(new Map())
	const transcriptionConfigModeRef = useRef<'modern' | 'legacy'>('modern')
	// Conversation ordering hints (linked-list ordering via previous_item_id).
	const previousItemIdByIdRef = useRef<Map<string, string | null>>(new Map())
	// Anchor assistant responses to the correct user turn even if events arrive out of order.
	const anchoredInputIdByResponseIdRef = useRef<Map<string, string>>(new Map())
	const latestCommittedInputItemIdRef = useRef<string | null>(null)
	// Buffer assistant deltas until we know the real output item id (avoids synthetic ids + duplicates).
	const pendingAssistantDeltasByResponseIdRef = useRef<
		Map<string, { text: string; audioTranscript: string }>
	>(new Map())
	const speechEnabledRef = useRef(true)
	const micEnabledRef = useRef(true)

	const cleanup = useCallback(() => {
		peerRef.current?.close()
		peerRef.current = null
		for (const track of localRef.current?.getTracks() ?? []) track.stop()
		localRef.current = null
		setRemoteStream(null)
		setDataChannel(null)
		assistantMessageIdByResponseIdRef.current.clear()
		assistantPreferredSourceByIdRef.current.clear()
		previousItemIdByIdRef.current.clear()
		anchoredInputIdByResponseIdRef.current.clear()
		latestCommittedInputItemIdRef.current = null
		pendingAssistantDeltasByResponseIdRef.current.clear()
	}, [])

	const clearTranscripts = useCallback(() => {
		setTranscripts([])
		assistantMessageIdByResponseIdRef.current.clear()
		assistantPreferredSourceByIdRef.current.clear()
		previousItemIdByIdRef.current.clear()
		anchoredInputIdByResponseIdRef.current.clear()
		latestCommittedInputItemIdRef.current = null
		pendingAssistantDeltasByResponseIdRef.current.clear()
	}, [])

	const reorderTranscripts = useCallback(() => {
		setTranscripts(prev => orderTranscriptsByPreviousItemId(prev, previousItemIdByIdRef.current))
	}, [])

	const upsertTranscript = useCallback(
		(update: {
			id: string
			role: 'user' | 'assistant'
			source: RealtimeTranscriptMessage['source'] | 'input_text'
			appendDelta?: string
			replaceText?: string
			finalize?: boolean
			previousItemId?: string | null
		}) => {
			setTranscripts(prev => {
				const idx = prev.findIndex(item => item.id === update.id)
				const existing = idx >= 0 ? prev[idx] : null

				// If we already have assistant text streaming, don't overwrite it with audio transcript deltas.
				if (
					existing?.role === 'assistant' &&
					existing?.source === 'response_text' &&
					existing?.text.trim().length > 0 &&
					update.source === 'response_audio_transcript'
				) {
					return prev
				}

				const shouldResetAssistantText =
					typeof update.replaceText !== 'string' &&
					existing?.role === 'assistant' &&
					existing?.source === 'response_audio_transcript' &&
					update.source === 'response_text' &&
					typeof update.appendDelta === 'string'

				const next: RealtimeTranscriptMessage = {
					id: update.id,
					role: update.role,
					source: update.source,
					status: update.finalize ? 'final' : (existing?.status ?? 'streaming'),
					text:
						typeof update.replaceText === 'string'
							? update.replaceText
							: shouldResetAssistantText
								? (update.appendDelta ?? '')
								: (existing?.text ?? '') + (update.appendDelta ?? '')
				}

				if (typeof update.previousItemId !== 'undefined') {
					previousItemIdByIdRef.current.set(update.id, update.previousItemId)
				}

				// Preserve the "better" assistant source once we see it.
				if (
					next.role === 'assistant' &&
					(next.source === 'response_text' || next.source === 'response_audio_transcript')
				) {
					assistantPreferredSourceByIdRef.current.set(next.id, next.source)
				}

				if (idx === -1)
					return orderTranscriptsByPreviousItemId([...prev, next], previousItemIdByIdRef.current)

				const copy = prev.slice()
				copy[idx] = next
				return orderTranscriptsByPreviousItemId(copy, previousItemIdByIdRef.current)
			})
		},
		[]
	)

	const finalizeAssistantTranscript = useCallback((assistantId?: string) => {
		setTranscripts(prev => {
			if (assistantId) {
				const idx = prev.findIndex(item => item.id === assistantId)
				if (idx === -1) return prev
				const current = prev[idx]
				if (!current || current.status === 'final') return prev
				const copy = prev.slice()
				copy[idx] = { ...current, status: 'final' }
				return orderTranscriptsByPreviousItemId(copy, previousItemIdByIdRef.current)
			}

			for (let i = prev.length - 1; i >= 0; i -= 1) {
				const item = prev[i]
				if (item?.role === 'assistant' && item.status !== 'final') {
					const copy = prev.slice()
					copy[i] = { ...item, status: 'final' }
					return orderTranscriptsByPreviousItemId(copy, previousItemIdByIdRef.current)
				}
			}
			return prev
		})
	}, [])

	const start = useCallback(
		async (opts?: { instructions?: string; voice?: string; model?: string }) => {
			console.log('[realtime] start() called', { opts })
			// Invalidate any in-flight start and tear down any existing session before creating a new one.
			startGenerationRef.current += 1
			const generation = startGenerationRef.current
			cleanup()
			clearTranscripts()
			let mic: MediaStream | null = null
			let pc: RTCPeerConnection | null = null
			try {
				const session = await createRealtimeSession({
					instructions: opts?.instructions,
					model: opts?.model,
					voice: opts?.voice
				})
				const clientSecret = session.client_secret.value
				const model = session.model
				console.log('[realtime] created session', { expires_at: session.expires_at, model })

				mic = await navigator.mediaDevices.getUserMedia({
					audio: {
						autoGainControl: true,
						echoCancellation: true,
						noiseSuppression: true
					}
				})
				if (startGenerationRef.current !== generation) {
					for (const track of mic.getTracks()) track.stop()
					return
				}
				console.log('[realtime] obtained microphone stream', {
					audioTracks: mic.getAudioTracks().length
				})
				localRef.current = mic
				for (const track of mic.getTracks()) {
					track.enabled = micEnabledRef.current
				}

				const peer = new RTCPeerConnection()
				pc = peer
				peerRef.current = peer
				peer.addEventListener('icecandidate', e => {
					console.log('[realtime] icecandidate', { candidate: Boolean(e.candidate) })
				})
				peer.addEventListener('icegatheringstatechange', () => {
					console.log('[realtime] icegatheringstatechange', peer.iceGatheringState)
				})
				peer.addEventListener('signalingstatechange', () => {
					console.log('[realtime] signalingstatechange', peer.signalingState)
				})
				peer.addEventListener('connectionstatechange', () => {
					console.log('[realtime] connectionstatechange', peer.connectionState)
				})
				// Guard optional event for browsers that support it
				;(
					peer as unknown as { addEventListener?: (t: string, cb: (e: unknown) => void) => void }
				).addEventListener?.('icecandidateerror', (e: unknown) => {
					console.warn('[realtime] icecandidateerror', e)
				})

				peer.addEventListener('track', event => {
					const [first] = event.streams
					if (!first) return
					setRemoteStream(first)
					console.log('[realtime] remote track added', {
						kind: event.track.kind,
						remoteAudioTracks: first.getAudioTracks().length
					})
				})

				for (const track of mic.getTracks()) {
					peer.addTrack(track, mic)
				}

				const dc = peer.createDataChannel('oai-events')
				setDataChannel(dc)
				dc.addEventListener('open', () => {
					console.log('[realtime] datachannel open')
					try {
						// Always set transcription + (optional) session preferences.
						transcriptionConfigModeRef.current = 'modern'
						const silenceDurationMs = Math.round(turnDelaySecondsRef.current * 1000)
						dc.send(
							JSON.stringify({
								session: {
									...(speechEnabledRef.current && opts?.voice ? { voice: opts.voice } : {}),
									...(opts?.instructions ? { instructions: opts.instructions } : {}),
									audio: {
										input: {
											// High-quality live transcription of user audio.
											transcription: {
												model: 'gpt-4o-transcribe'
											}
										}
									},
									// Request both audio and text so we can display a high-quality text timeline.
									modalities: speechEnabledRef.current ? ['audio', 'text'] : ['text'],
									turn_detection: {
										silence_duration_ms: silenceDurationMs,
										type: 'server_vad'
									}
								},
								type: 'session.update'
							})
						)
						console.log('[realtime] sent session.update (modalities + transcription + turn_detection)', {
							silenceDurationMs
						})
					} catch {}
				})
				dc.addEventListener('close', () => {
					console.log('[realtime] datachannel close')
				})
				dc.addEventListener('message', e => {
					try {
						const msg = JSON.parse(String(e.data))
						const type = msg?.type
						if (typeof type === 'string') {
							// If the API rejects modern config keys, fall back to legacy input_audio_transcription.
							if (type === 'error') {
								const message =
									(typeof msg?.error?.message === 'string' && msg.error.message) ||
									(typeof msg?.message === 'string' && msg.message) ||
									''
								if (
									transcriptionConfigModeRef.current === 'modern' &&
									/message|unknown|unexpected|unrecognized|invalid/i.test(message) &&
									/audio|transcription|modalities|input_audio_transcription/i.test(message)
								) {
									try {
										transcriptionConfigModeRef.current = 'legacy'
										dc.send(
											JSON.stringify({
												session: {
													// Legacy field name used in older examples.
													input_audio_transcription: { model: 'whisper-1' }
												},
												type: 'session.update'
											})
										)
										console.warn('[realtime] fell back to legacy input_audio_transcription config', {
											message
										})
									} catch {}
								}
								// Keep logging errors for debugging.
								console.warn('[realtime] error event', msg)
								return
							}

							const getAnchoredInputItemId = (responseId: string): string | null => {
								const existing = anchoredInputIdByResponseIdRef.current.get(responseId)
								if (existing) return existing
								const latest = latestCommittedInputItemIdRef.current
								if (!latest) return null
								anchoredInputIdByResponseIdRef.current.set(responseId, latest)
								return latest
							}

							// Audio input turn has been committed into a conversation item (includes ordering).
							if (type === 'input_audio_buffer.committed') {
								const itemId = msg?.item_id
								const previousItemId =
									typeof msg?.previous_item_id === 'string' ? msg.previous_item_id : null

								if (typeof itemId === 'string') {
									latestCommittedInputItemIdRef.current = itemId
									upsertTranscript({
										id: itemId,
										previousItemId,
										role: 'user',
										source: 'input_transcription'
									})
								}
								return
							}

							// Conversation items are emitted as a linked list via previous_item_id; use this to order the UI.
							if (type === 'conversation.item.created') {
								const itemId = typeof msg?.item?.id === 'string' ? msg.item.id : undefined
								const role = msg?.item?.role
								const content = Array.isArray(msg?.item?.content) ? msg.item.content : []
								const inputText = content.find((entry: { type?: string }) => entry?.type === 'input_text')
								const text = typeof inputText?.text === 'string' ? inputText.text : null
								const previousItemId =
									typeof msg?.previous_item_id === 'string'
										? msg.previous_item_id
										: typeof msg?.item?.previous_item_id === 'string'
											? msg.item.previous_item_id
											: null

								if (typeof itemId === 'string') {
									previousItemIdByIdRef.current.set(itemId, previousItemId)
									if (role === 'user') {
										latestCommittedInputItemIdRef.current = itemId
										if (text !== null) {
											upsertTranscript({
												id: itemId,
												previousItemId,
												replaceText: text,
												role: 'user',
												source: 'input_text'
											})
										}
									}
									reorderTranscripts()
								}
								return
							}

							// User audio transcription streaming.
							if (type === 'conversation.item.input_audio_transcription.delta') {
								const itemId = msg?.item_id
								const delta = msg?.delta
								if (typeof itemId === 'string' && typeof delta === 'string' && delta) {
									if (!latestCommittedInputItemIdRef.current) latestCommittedInputItemIdRef.current = itemId
									upsertTranscript({
										appendDelta: delta,
										id: itemId,
										previousItemId: previousItemIdByIdRef.current.has(itemId)
											? (previousItemIdByIdRef.current.get(itemId) ?? null)
											: typeof msg?.previous_item_id === 'string'
												? msg.previous_item_id
												: undefined,
										role: 'user',
										source: 'input_transcription'
									})
								}
								return
							}
							if (type === 'conversation.item.input_audio_transcription.completed') {
								const itemId = msg?.item_id
								const transcript = msg?.transcript
								if (typeof itemId === 'string' && typeof transcript === 'string') {
									if (!latestCommittedInputItemIdRef.current) latestCommittedInputItemIdRef.current = itemId
									upsertTranscript({
										finalize: true,
										id: itemId,
										previousItemId: previousItemIdByIdRef.current.has(itemId)
											? (previousItemIdByIdRef.current.get(itemId) ?? null)
											: typeof msg?.previous_item_id === 'string'
												? msg.previous_item_id
												: undefined,
										replaceText: transcript,
										role: 'user',
										source: 'input_transcription'
									})
								}
								return
							}

							// Keep track of which output item id belongs to a given response.
							if (type === 'response.output_item.added') {
								const responseId = msg?.response_id
								const itemId = msg?.item?.id
								const explicitPreviousItemId =
									typeof msg?.item?.previous_item_id === 'string'
										? msg.item.previous_item_id
										: typeof msg?.previous_item_id === 'string'
											? msg.previous_item_id
											: undefined
								if (typeof responseId === 'string' && typeof itemId === 'string') {
									// Canonical mapping from response_id -> output item id.
									assistantMessageIdByResponseIdRef.current.set(responseId, itemId)

									// Anchor this response to the most recently committed input item (only once).
									if (!anchoredInputIdByResponseIdRef.current.has(responseId)) {
										const latest = latestCommittedInputItemIdRef.current
										if (latest) anchoredInputIdByResponseIdRef.current.set(responseId, latest)
									}

									const anchor = getAnchoredInputItemId(responseId)
									const previousItemId =
										typeof explicitPreviousItemId === 'string' ? explicitPreviousItemId : anchor
									if (typeof previousItemId === 'string') {
										previousItemIdByIdRef.current.set(itemId, previousItemId)
										reorderTranscripts()
									}

									const pending = pendingAssistantDeltasByResponseIdRef.current.get(responseId)
									if (pending) {
										if (pending.text) {
											upsertTranscript({
												appendDelta: pending.text,
												id: itemId,
												role: 'assistant',
												source: 'response_text',
												...(typeof previousItemId === 'string' ? { previousItemId } : {})
											})
										} else if (pending.audioTranscript) {
											upsertTranscript({
												appendDelta: pending.audioTranscript,
												id: itemId,
												role: 'assistant',
												source: 'response_audio_transcript',
												...(typeof previousItemId === 'string' ? { previousItemId } : {})
											})
										}
										pendingAssistantDeltasByResponseIdRef.current.delete(responseId)
									}
								}
								// no return; we still might want to log unknown shapes in dev
							}

							// Assistant transcript streaming (preferred when text modality is not present).
							if (type === 'response.audio_transcript.delta') {
								const responseId = typeof msg?.response_id === 'string' ? msg.response_id : null
								const inlineItemId = typeof msg?.item_id === 'string' ? msg.item_id : undefined
								const stableFromResponse = responseId
									? assistantMessageIdByResponseIdRef.current.get(responseId)
									: undefined
								const itemId = stableFromResponse ?? inlineItemId

								const delta = msg?.delta
								if (typeof delta === 'string' && delta) {
									if (!itemId && responseId) {
										const pending = pendingAssistantDeltasByResponseIdRef.current.get(responseId) ?? {
											audioTranscript: '',
											text: ''
										}
										pending.audioTranscript += delta
										pendingAssistantDeltasByResponseIdRef.current.set(responseId, pending)
										return
									}

									if (typeof itemId === 'string') {
										if (responseId && !stableFromResponse) {
											assistantMessageIdByResponseIdRef.current.set(responseId, itemId)
										}

										const anchor = responseId ? getAnchoredInputItemId(responseId) : null
										const previousItemId = previousItemIdByIdRef.current.has(itemId)
											? (previousItemIdByIdRef.current.get(itemId) ?? null)
											: typeof msg?.previous_item_id === 'string'
												? msg.previous_item_id
												: (anchor ?? undefined)
										upsertTranscript({
											appendDelta: delta,
											id: itemId,
											previousItemId,
											role: 'assistant',
											source: 'response_audio_transcript'
										})
									}
								}
								return
							}

							// Assistant text streaming (preferred when available).
							if (type === 'response.text.delta') {
								const delta = msg?.delta
								const responseId = typeof msg?.response_id === 'string' ? msg.response_id : null
								const inlineItemId = typeof msg?.item_id === 'string' ? msg.item_id : undefined
								const stableFromResponse = responseId
									? assistantMessageIdByResponseIdRef.current.get(responseId)
									: undefined
								const itemId = stableFromResponse ?? inlineItemId

								if (typeof delta === 'string' && delta) {
									if (!itemId && responseId) {
										const pending = pendingAssistantDeltasByResponseIdRef.current.get(responseId) ?? {
											audioTranscript: '',
											text: ''
										}
										pending.text += delta
										pendingAssistantDeltasByResponseIdRef.current.set(responseId, pending)
										return
									}

									if (typeof itemId === 'string') {
										if (responseId && !stableFromResponse) {
											assistantMessageIdByResponseIdRef.current.set(responseId, itemId)
										}

										const anchor = responseId ? getAnchoredInputItemId(responseId) : null
										const previousItemId = previousItemIdByIdRef.current.has(itemId)
											? (previousItemIdByIdRef.current.get(itemId) ?? null)
											: typeof msg?.previous_item_id === 'string'
												? msg.previous_item_id
												: (anchor ?? undefined)
										upsertTranscript({
											appendDelta: delta,
											id: itemId,
											previousItemId,
											role: 'assistant',
											source: 'response_text'
										})
									}
								}
								return
							}

							// Mark the assistant message as complete at the end of the response.
							if (type === 'response.done') {
								const responseId = typeof msg?.response_id === 'string' ? msg.response_id : null
								const assistantId = responseId
									? assistantMessageIdByResponseIdRef.current.get(responseId)
									: undefined
								finalizeAssistantTranscript(assistantId)
								if (responseId) pendingAssistantDeltasByResponseIdRef.current.delete(responseId)
								return
							}
						}

						console.log('[realtime] dc message', msg?.type ?? 'unknown', msg)
					} catch {
						console.log('[realtime] dc message (text)', String(e.data))
					}
				})

				const offer = await pc.createOffer()
				if (startGenerationRef.current !== generation) {
					try {
						pc.close()
					} catch {}
					for (const track of mic.getTracks()) track.stop()
					return
				}
				console.log('[realtime] created local offer', { sdpBytes: offer.sdp?.length ?? 0 })
				await pc.setLocalDescription(offer)
				if (startGenerationRef.current !== generation) {
					try {
						pc.close()
					} catch {}
					for (const track of mic.getTracks()) track.stop()
					return
				}
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
				if (startGenerationRef.current !== generation) {
					try {
						pc.close()
					} catch {}
					for (const track of mic.getTracks()) track.stop()
					return
				}
				console.log('[realtime] received remote answer', { sdpBytes: answer.length })
				await pc.setRemoteDescription({ sdp: answer, type: 'answer' })
				if (startGenerationRef.current !== generation) {
					try {
						pc.close()
					} catch {}
					for (const track of mic.getTracks()) track.stop()
					return
				}
				console.log('[realtime] setRemoteDescription complete')
			} catch (error) {
				// Ignore transient errors caused by StrictMode / rapid cancels.
				if (startGenerationRef.current !== generation) return
				try {
					pc?.close()
				} catch {}
				for (const track of mic?.getTracks() ?? []) track.stop()
				throw error
			}
		},
		[cleanup, clearTranscripts, finalizeAssistantTranscript, reorderTranscripts, upsertTranscript]
	)

	const stop = useCallback(() => {
		console.log('[realtime] stop() called')
		// Cancel any in-flight `start()` and ensure it won't revive a closed session.
		startGenerationRef.current += 1
		cleanup()
		clearTranscripts()
	}, [cleanup, clearTranscripts])

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

	const updateTurnDelaySeconds = useCallback(
		(seconds: number) => {
			const normalized = normalizeTurnDelaySeconds(seconds)
			if (normalized === null) return
			turnDelaySecondsRef.current = normalized
			if (!dataChannel) return
			try {
				dataChannel.send(
					JSON.stringify({
						session: {
							turn_detection: {
								silence_duration_ms: Math.round(normalized * 1000),
								type: 'server_vad'
							}
						},
						type: 'session.update'
					})
				)
			} catch {
				// ignore
			}
		},
		[dataChannel]
	)

	const updateSpeechEnabled = useCallback(
		(enabled: boolean) => {
			speechEnabledRef.current = enabled
			if (!dataChannel) return
			try {
				dataChannel.send(
					JSON.stringify({
						session: {
							...(enabled ? { voice: 'verse' } : {}),
							modalities: enabled ? ['audio', 'text'] : ['text']
						},
						type: 'session.update'
					})
				)
			} catch {
				// ignore
			}
		},
		[dataChannel]
	)

	const updateMicEnabled = useCallback((enabled: boolean) => {
		micEnabledRef.current = enabled
		for (const track of localRef.current?.getTracks() ?? []) {
			track.enabled = enabled
		}
	}, [])

	const sendText = useCallback(
		(text: string) => {
			const trimmed = text.trim()
			if (!trimmed || !dataChannel) return false
			const id = crypto.randomUUID()
			const previousItemId = latestCommittedInputItemIdRef.current
			previousItemIdByIdRef.current.set(id, previousItemId ?? null)
			latestCommittedInputItemIdRef.current = id
			upsertTranscript({
				id,
				previousItemId,
				replaceText: trimmed,
				role: 'user',
				source: 'input_text'
			})
			try {
				dataChannel.send(
					JSON.stringify({
						item: {
							content: [{ text: trimmed, type: 'input_text' }],
							id,
							role: 'user',
							type: 'message'
						},
						type: 'conversation.item.create'
					})
				)
				dataChannel.send(
					JSON.stringify({
						type: 'response.create'
					})
				)
				return true
			} catch {
				return false
			}
		},
		[dataChannel, upsertTranscript]
	)

	const value = useMemo<RealtimeContextValue>(
		() => ({
			clearTranscripts,
			dataChannel,
			remoteStream,
			sendText,
			start,
			stop,
			transcripts,
			updateInstructions,
			updateMicEnabled,
			updateSpeechEnabled,
			updateTurnDelaySeconds,
			updateVoice
		}),
		[
			dataChannel,
			remoteStream,
			transcripts,
			start,
			updateSpeechEnabled,
			updateInstructions,
			updateVoice,
			updateTurnDelaySeconds,
			updateMicEnabled,
			sendText,
			clearTranscripts,
			stop
		]
	)

	return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}

export function useRealtimeVoiceSession(): RealtimeContextValue {
	const ctx = useContext(RealtimeContext)
	if (!ctx) throw new Error('useRealtimeVoiceSession must be used within a RealtimeProvider')
	return ctx
}
