'use client'

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

import { createRealtimeSession } from '@/app/actions/realtime'

type Participant = {
        id: string
        name: string
        primaryLanguage: string
        targetLanguage: string | null
}

type StartOptions = { instructions?: string; voice?: string; model?: string }

type RealtimeContextValue = {
        dataChannel: RTCDataChannel | null
        participants: Participant[]
        remoteStream: MediaStream | null
        setParticipantTargetLanguage: (participantId: string, language: string | null) => void
        start: (opts?: StartOptions) => Promise<void>
        updateInstructions: (text: string) => void
        updateVoice: (voice: string) => void
        stop: () => void
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null)

const PARTICIPANT_TOOLS = [
        {
                description:
                        'Record a participant who has introduced themselves, including their preferred and translation languages.',
                name: 'add_or_update_participant',
                parameters: {
                        properties: {
                                participant_id: {
                                        description: 'A stable identifier for the participant.',
                                        type: 'string'
                                },
                                display_name: {
                                        description: 'How the participant introduced themselves.',
                                        type: 'string'
                                },
                                primary_language: {
                                        description: 'BCP-47 code describing the language they prefer to speak.',
                                        type: 'string'
                                },
                                target_language: {
                                        description:
                                                'Optional BCP-47 code describing the language they prefer receiving translations in.',
                                        nullable: true,
                                        type: 'string'
                                }
                        },
                        required: ['participant_id', 'display_name', 'primary_language'],
                        type: 'object'
                },
                type: 'function'
        },
        {
                description: 'Update the language a participant would like translations delivered in.',
                name: 'set_participant_target_language',
                parameters: {
                        properties: {
                                participant_id: { type: 'string' },
                                target_language: { nullable: true, type: 'string' }
                        },
                        required: ['participant_id'],
                        type: 'object'
                },
                type: 'function'
        },
        {
                description: 'Remove a participant who is no longer present.',
                name: 'remove_participant',
                parameters: {
                        properties: {
                                participant_id: { type: 'string' }
                        },
                        required: ['participant_id'],
                        type: 'object'
                },
                type: 'function'
        }
]

type ToolCallMessage = {
        call?: {
                arguments?: string
                id: string
                name: string
                type?: string
        }
        response_id?: string
        type?: string
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
        const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
        const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null)
        const [participants, setParticipants] = useState<Participant[]>([])
        const peerRef = useRef<RTCPeerConnection | null>(null)
        const localRef = useRef<MediaStream | null>(null)

        const cleanup = useCallback(() => {
                peerRef.current?.close()
                peerRef.current = null
                for (const track of localRef.current?.getTracks() ?? []) track.stop()
                localRef.current = null
                setRemoteStream(null)
                setDataChannel(null)
                setParticipants([])
        }, [])

        const start = useCallback(
                async (opts?: StartOptions) => {
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
                        const handleToolCall = (message: ToolCallMessage) => {
                                const call = message.call
                                if (!call) return
                                if (call.type && call.type !== 'function') return
                                const { name, id } = call
                                let parsedArguments: Record<string, unknown> | null = null
                                try {
                                        parsedArguments = call.arguments ? JSON.parse(call.arguments) : {}
                                } catch (error) {
                                        console.warn('[realtime] failed to parse tool arguments', error)
                                }
                                const ack = (payload?: unknown) => {
                                        if (!message.response_id) return
                                        const output =
                                                payload === undefined
                                                        ? 'ok'
                                                        : typeof payload === 'string'
                                                        ? payload
                                                        : JSON.stringify(payload)
                                        try {
                                                dc.send(
                                                        JSON.stringify({
                                                                output,
                                                                response_id: message.response_id,
                                                                tool_call_id: id,
                                                                type: 'response.input_tool_output'
                                                        })
                                                )
                                        } catch (error) {
                                                console.warn('[realtime] failed to ack tool call', error)
                                        }
                                }

                                if (name === 'add_or_update_participant' && parsedArguments) {
                                        const participantId = String(parsedArguments.participant_id ?? '').trim()
                                        const displayName = String(parsedArguments.display_name ?? '').trim()
                                        const primaryLanguage = String(parsedArguments.primary_language ?? '').trim()
                                        const targetLanguageValue = parsedArguments.target_language
                                        const targetLanguage =
                                                typeof targetLanguageValue === 'string' && targetLanguageValue.length > 0
                                                        ? targetLanguageValue
                                                        : null

                                        if (!participantId || !displayName || !primaryLanguage) {
                                                ack({ error: 'Missing participant_id, display_name, or primary_language.' })
                                                return
                                        }

                                        setParticipants(prev => {
                                                const existingIndex = prev.findIndex(
                                                        participant => participant.id === participantId
                                                )
                                        
                                                const payload: Participant = {
                                                        id: participantId,
                                                        name: displayName,
                                                        primaryLanguage,
                                                        targetLanguage: targetLanguage ?? null
                                                }

                                                if (existingIndex === -1) {
                                                        return [...prev, payload]
                                                }

                                                const next = [...prev]
                                                next[existingIndex] = payload
                                                return next
                                        })

                                        ack({ status: 'recorded' })
                                        return
                                }

                                if (name === 'set_participant_target_language' && parsedArguments) {
                                        const participantId = String(parsedArguments.participant_id ?? '').trim()
                                        if (!participantId) {
                                                ack({ error: 'Missing participant_id.' })
                                                return
                                        }
                                        const targetLanguageValue = parsedArguments.target_language
                                        const targetLanguage =
                                                typeof targetLanguageValue === 'string' && targetLanguageValue.length > 0
                                                        ? targetLanguageValue
                                                        : null

                                        setParticipants(prev => {
                                                const index = prev.findIndex(p => p.id === participantId)
                                                if (index === -1) return prev
                                                const next: Participant[] = [...prev]
                                                const updated = {
                                                        ...next[index],
                                                        targetLanguage
                                                } as Participant
                                                next[index] = updated
                                                return next
                                        })

                                        ack({ status: 'updated' })
                                        return
                                }

                                if (name === 'remove_participant' && parsedArguments) {
                                        const participantId = String(parsedArguments.participant_id ?? '').trim()
                                        if (!participantId) {
                                                ack({ error: 'Missing participant_id.' })
                                                return
                                        }
                                        setParticipants(prev => prev.filter(participant => participant.id !== participantId))
                                        ack({ status: 'removed' })
                                }
                        }

                        const onMessage = (event: MessageEvent) => {
                                try {
                                        const msg = JSON.parse(String(event.data)) as ToolCallMessage
                                        if (msg?.type === 'response.output_tool_call') {
                                                handleToolCall(msg)
                                                return
                                        }
                                        console.log('[realtime] dc message', msg?.type ?? 'unknown', msg)
                                } catch (error) {
                                        console.log('[realtime] dc message (text)', String(event.data))
                                }
                        }

                        dc.addEventListener('open', () => {
                                console.log('[realtime] datachannel open')
                                // Ensure session settings (voice/instructions) are applied then trigger a first response.
                                try {
                                        dc.send(
                                                JSON.stringify({
                                                        session: {
                                                                tools: PARTICIPANT_TOOLS,
                                                                ...(opts?.voice ? { voice: opts.voice } : {}),
                                                                ...(opts?.instructions ? { instructions: opts.instructions } : {})
                                                        },
                                                        type: 'session.update'
                                                })
                                        )
                                        console.log('[realtime] sent session.update')
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
                                dc.removeEventListener('message', onMessage)
                        })
                        dc.addEventListener('message', onMessage)

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

        const setParticipantTargetLanguage = useCallback(
                (participantId: string, language: string | null) => {
                        setParticipants(prev => {
                                const index = prev.findIndex(participant => participant.id === participantId)
                                if (index === -1) return prev
                                const next: Participant[] = [...prev]
                                const updated = {
                                        ...next[index],
                                        targetLanguage: language
                                } as Participant
                                next[index] = updated
                                return next
                        })
                },
                []
        )

        const value = useMemo<RealtimeContextValue>(
                () => ({
                        dataChannel,
                        participants,
                        remoteStream,
                        setParticipantTargetLanguage,
                        start,
                        stop,
                        updateInstructions,
                        updateVoice
                }),
                [dataChannel, participants, remoteStream, setParticipantTargetLanguage, start, updateInstructions, updateVoice, stop]
        )

	return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}

export function useRealtimeVoiceSession(): RealtimeContextValue {
        const ctx = useContext(RealtimeContext)
        if (!ctx) throw new Error('useRealtimeVoiceSession must be used within a RealtimeProvider')
        return ctx
}

export type { Participant }
