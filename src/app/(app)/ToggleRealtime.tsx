'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useRealtimeVoiceSession } from '@/realtime/provider'

const defaultPrompt = `You are Lilac, a human-first translation facilitator.

Core principles:
- Stay silent until a participant speaks. Never initiate conversations or offer greetings on your own.
- Focus exclusively on translating what people say. Keep responses concise, neutral, and free from commentary.
- Ask clarifying questions only when you truly need information to configure translation directions.

Onboarding flow:
1. When the first participant speaks, respond in their language. Acknowledge them briefly and ask which language they want translations delivered into. Wait for their answer.
2. Once a translation direction is confirmed, remember it. For each of that speaker's future utterances, return only the translation, formatted as "[Target language] {translation}" for every listener.
3. When a new participant joins, reply in their language, confirm whom you will translate for, and ensure everyone knows which languages they will receive. Keep confirmations short.
4. Track all participants, their names, and their preferred languages. Provide translations for every other participant. Use labels such as "[English → John] {translation}" when you know their name, otherwise default to the language label.
5. Do not teach, embellish, or comment on the content of the conversation. Translate faithfully and efficiently.
6. If you cannot determine a speaker's language, politely ask them—in your best guess of their language—to clarify.

Your sole job is to provide fast, faithful translations that keep the conversation flowing.`

const languagePhrases = [
	{ code: 'en', text: 'Introduce yourself' },
	{ code: 'es', text: 'Preséntate' },
	{ code: 'zh', text: '请介绍一下自己' },
	{ code: 'hi', text: 'अपना परिचय दीजिए' },
	{ code: 'ar', text: 'قدّم نفسك' },
	{ code: 'fr', text: 'Présentez-vous' },
	{ code: 'de', text: 'Stell dich vor' },
	{ code: 'ja', text: '自己紹介をしてください' },
	{ code: 'pt', text: 'Apresente-se' },
	{ code: 'ru', text: 'Представьтесь' },
	{ code: 'ko', text: '자기소개를 해 주세요' },
	{ code: 'it', text: 'Presentati' }
]

type ConnectionState = 'idle' | 'requesting' | 'ready' | 'error'

export default function ToggleRealtime() {
	const { start, stop, remoteStream, updateInstructions, updateVoice } = useRealtimeVoiceSession()
	const [connectionState, setConnectionState] = useState<ConnectionState>('idle')
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [languageOrder, setLanguageOrder] = useState(languagePhrases)
	const audioContextRef = useRef<AudioContext | null>(null)
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
	const startedRef = useRef(false)
	const cancelInitRef = useRef(false)

	useEffect(() => {
		if (typeof navigator === 'undefined') return
		const navLanguages = navigator.languages ?? [navigator.language]
		const normalized = navLanguages.map(lang => lang?.toLowerCase?.() ?? '').filter(Boolean)

		if (!normalized.length) return

		const seen = new Set<string>()
		const prioritized: typeof languagePhrases = []

		for (const navLang of normalized) {
			const match = languagePhrases.find(
				phrase => navLang === phrase.code || navLang.startsWith(`${phrase.code}-`)
			)
			if (match && !seen.has(match.code)) {
				prioritized.push(match)
				seen.add(match.code)
			}
		}

		for (const phrase of languagePhrases) {
			if (!seen.has(phrase.code)) {
				prioritized.push(phrase)
				seen.add(phrase.code)
			}
		}

		setLanguageOrder(prioritized)
	}, [])

	const ensureAudioContext = useCallback(() => {
		const Ctx =
			window.AudioContext ??
			(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
		if (!Ctx) throw new Error('AudioContext is not supported in this browser')

		if (!audioContextRef.current) {
			audioContextRef.current = new Ctx()
			console.log('[lilac] created AudioContext', { state: audioContextRef.current.state })
		}

		if (audioContextRef.current.state === 'suspended') {
			void audioContextRef.current
				.resume()
				.then(() => {
					console.log('[lilac] AudioContext resumed', {
						state: audioContextRef.current?.state
					})
				})
				.catch(error => {
					console.warn('[lilac] failed to resume AudioContext', error)
				})
		}

		return audioContextRef.current
	}, [])

	useEffect(() => {
		if (!remoteStream) return

		let cancelled = false

		const connectRemoteAudio = async () => {
			console.log('[lilac] remoteStream updated', {
				hasStream: Boolean(remoteStream),
				tracks: remoteStream?.getTracks().length
			})

			if (!remoteStream.getAudioTracks().length) {
				const onAddTrack = () => {
					remoteStream.removeEventListener('addtrack', onAddTrack as EventListener)
					void connectRemoteAudio()
				}
				remoteStream.addEventListener('addtrack', onAddTrack as EventListener)
				return
			}

			try {
				const ctx = ensureAudioContext()
				if (!ctx || cancelled) return
				const src = ctx.createMediaStreamSource(remoteStream)
				sourceRef.current = src
				src.connect(ctx.destination)
			} catch (error) {
				console.error('[lilac] failed to connect remote audio', error)
			}
		}

		void connectRemoteAudio()

		return () => {
			cancelled = true
			console.log('[lilac] cleaning audio graph')
			try {
				sourceRef.current?.disconnect()
			} catch {}
			sourceRef.current = null
			try {
				void audioContextRef.current?.close()
			} catch {}
			audioContextRef.current = null
		}
	}, [remoteStream, ensureAudioContext])

	const beginSession = useCallback(async () => {
		if (startedRef.current) return
		startedRef.current = true
		setConnectionState('requesting')
		setErrorMessage(null)

		try {
			ensureAudioContext()
			updateVoice('verse')
			await start({ instructions: defaultPrompt, voice: 'verse' })
			if (cancelInitRef.current) {
				startedRef.current = false
				return
			}
			updateInstructions(defaultPrompt)
			setConnectionState('ready')
		} catch (error) {
			console.error('[lilac] failed to start realtime session', error)
			startedRef.current = false
			if (cancelInitRef.current) return
			setConnectionState('error')
			const message =
				error instanceof Error ? error.message : 'Something went wrong while starting Lilac.'
			setErrorMessage(message)
		}
	}, [ensureAudioContext, start, updateInstructions, updateVoice])

	useEffect(() => {
		cancelInitRef.current = false
		let cancelled = false

		const run = async () => {
			if (cancelled) return
			await beginSession()
		}

		void run()

		return () => {
			cancelled = true
			cancelInitRef.current = true
			startedRef.current = false
			stop()
			try {
				sourceRef.current?.disconnect()
			} catch {}
			sourceRef.current = null
			try {
				void audioContextRef.current?.close()
			} catch {}
			audioContextRef.current = null
		}
	}, [beginSession, stop])

	const statusText = useMemo(() => {
		if (connectionState === 'requesting') return 'Requesting microphone…'
		if (connectionState === 'ready') return 'Listening'
		if (connectionState === 'error')
			return errorMessage ?? 'Unable to start. Check microphone permissions.'
		return 'Preparing Lilac…'
	}, [connectionState, errorMessage])

	const [activeIndex, setActiveIndex] = useState(0)

	useEffect(() => {
		if (!languageOrder.length) return
		const timer = window.setInterval(() => {
			setActiveIndex(current => (current + 1) % languageOrder.length)
		}, 3200)
		return () => {
			window.clearInterval(timer)
		}
	}, [languageOrder])

	const phrase = languageOrder[activeIndex] ?? languageOrder[0]

	return (
		<div className="relative box-border flex h-svh flex-col overflow-hidden">
			<div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(220%_200%_at_50%_-12%,rgba(255,255,255,0.95)_0%,rgba(247,243,231,0.98)_48%,rgba(247,243,231,1)_72%,rgba(206,190,255,0.6)_100%)] dark:bg-[radial-gradient(220%_200%_at_50%_-12%,rgba(40,31,61,0.95)_0%,rgba(24,18,38,0.98)_50%,rgba(24,18,38,1)_74%,rgba(89,70,120,0.65)_100%)]" />
			<div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[28dvh] bg-gradient-to-b from-white/65 via-transparent to-transparent dark:from-[#2d2248]/60 dark:via-transparent" />
			<div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[32dvh] bg-gradient-to-t from-[var(--lilac-surface)] via-transparent to-transparent dark:from-[#120c1e] dark:via-transparent" />
			<header
				className="absolute left-0 right-0 z-10 flex justify-start px-6 text-sm font-medium uppercase tracking-wide text-[var(--lilac-ink-muted)]"
				style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1.75rem)' }}
			>
				<span>Lilac</span>
			</header>
			<div className="relative z-10 flex flex-1 items-center justify-center px-6 text-center">
				<AnimatePresence mode="wait">
					<motion.span
						key={phrase?.code ?? 'fallback'}
						animate={{ opacity: 1, y: 0 }}
						className="block text-3xl font-semibold tracking-tight text-[var(--lilac-ink)] sm:text-4xl"
						exit={{ opacity: 0, y: 16 }}
						initial={{ opacity: 0, y: -16 }}
						transition={{ duration: 0.85, ease: 'easeInOut' }}
					>
						{phrase?.text ?? 'Introduce yourself'}
					</motion.span>
				</AnimatePresence>
			</div>
			<footer
				className="absolute left-0 right-0 z-10 flex justify-center px-6 text-xs font-medium uppercase tracking-[0.2em] text-[var(--lilac-ink-muted)]"
				style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 2rem)' }}
			>
				<span>{statusText}</span>
			</footer>
		</div>
	)
}
