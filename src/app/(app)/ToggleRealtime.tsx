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
	const [hasBootstrapped, setHasBootstrapped] = useState(false)
	const [languageOrder, setLanguageOrder] = useState(languagePhrases)
	const audioContextRef = useRef<AudioContext | null>(null)
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
	const startedRef = useRef(false)

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

	const ensureAudioContext = useCallback(async () => {
		const Ctx =
			window.AudioContext ??
			(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
		if (!Ctx) throw new Error('AudioContext is not supported in this browser')

		if (!audioContextRef.current) {
			audioContextRef.current = new Ctx()
			console.log('[lilac] created AudioContext', { state: audioContextRef.current.state })
		}

		try {
			await audioContextRef.current.resume()
			console.log('[lilac] AudioContext resumed', { state: audioContextRef.current.state })
		} catch (error) {
			console.warn('[lilac] failed to resume AudioContext', error)
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
				const ctx = await ensureAudioContext()
				if (!ctx || cancelled) return
				if (ctx.state === 'suspended') {
					await ctx.resume().catch(() => {})
				}
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
			await ensureAudioContext()
			updateVoice('verse')
			await start({ instructions: defaultPrompt, voice: 'verse' })
			updateInstructions(defaultPrompt)
			setConnectionState('ready')
		} catch (error) {
			console.error('[lilac] failed to start realtime session', error)
			startedRef.current = false
			setConnectionState('error')
			const message =
				error instanceof Error ? error.message : 'Something went wrong while starting Lilac.'
			setErrorMessage(message)
		}
	}, [ensureAudioContext, start, updateInstructions, updateVoice])

	useEffect(() => {
		if (hasBootstrapped) return
		setHasBootstrapped(true)
		void beginSession()

		return () => {
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
	}, [beginSession, hasBootstrapped, stop])

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
		<div className="relative flex min-h-svh flex-col overflow-hidden">
			<div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_120%_at_50%_15%,rgba(255,255,255,0.9)_0%,rgba(247,243,231,1)_55%,rgba(206,190,255,0.6)_100%)] dark:bg-[radial-gradient(120%_120%_at_50%_15%,rgba(40,31,61,0.9)_0%,rgba(24,18,38,1)_60%,rgba(89,70,120,0.65)_100%)]" />
			<div className="relative z-10 flex flex-1 flex-col">
				<header className="flex items-center justify-between px-6 pt-12 pb-10 font-medium text-[var(--lilac-ink-muted)] text-sm tracking-wide">
					<span className="uppercase">Lilac</span>
					<span className="font-normal text-xs">next generation translator</span>
				</header>
				<div className="flex flex-1 items-center justify-center px-6">
					<div className="rounded-3xl border border-white/30 bg-white/40 px-6 py-8 text-center shadow-[0_24px_80px_rgba(130,109,181,0.25)] backdrop-blur-lg transition-colors dark:border-white/10 dark:bg-white/5 dark:shadow-[0_24px_80px_rgba(40,30,70,0.45)]">
						<AnimatePresence mode="wait">
							<motion.span
								key={phrase?.code ?? 'fallback'}
								animate={{ opacity: 1, y: 0 }}
								className="block font-semibold text-3xl text-[var(--lilac-ink)] tracking-tight sm:text-4xl"
								exit={{ opacity: 0, y: 16 }}
								initial={{ opacity: 0, y: -16 }}
								transition={{ duration: 0.85, ease: 'easeInOut' }}
							>
								{phrase?.text ?? 'Introduce yourself'}
							</motion.span>
						</AnimatePresence>
					</div>
				</div>
				<footer className="flex items-center justify-between px-6 pb-12 text-[var(--lilac-ink-muted)] text-xs">
					<span>human-first, always on</span>
					<span className="font-medium uppercase tracking-[0.2em]">{statusText}</span>
				</footer>
			</div>
		</div>
	)
}
