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

type SessionState = 'idle' | 'requesting' | 'listening' | 'error'

export default function ToggleRealtime() {
	const { start, stop, remoteStream } = useRealtimeVoiceSession()
	const [sessionState, setSessionState] = useState<SessionState>('idle')
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [languageOrder, setLanguageOrder] = useState(languagePhrases)
	const [isStandalone, setIsStandalone] = useState(false)
	const audioContextRef = useRef<AudioContext | null>(null)
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
	const startPendingRef = useRef(false)

	useEffect(() => {
		if (typeof window === 'undefined') return
		const standalone =
			window.matchMedia?.('(display-mode: standalone)').matches ||
			(window.navigator as unknown as { standalone?: boolean }).standalone === true
		setIsStandalone(Boolean(standalone))
	}, [])

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
		if (!Ctx) throw new Error('AudioContext is not supported on this device')

		if (!audioContextRef.current) {
			audioContextRef.current = new Ctx()
			console.log('[lilac] created AudioContext', { state: audioContextRef.current.state })
		}

		if (audioContextRef.current.state === 'suspended') {
			try {
				await audioContextRef.current.resume()
				console.log('[lilac] AudioContext resumed', {
					state: audioContextRef.current?.state
				})
			} catch (error) {
				console.warn('[lilac] failed to resume AudioContext', error)
			}
		}

		return audioContextRef.current
	}, [])

	const cleanupAudioGraph = useCallback(() => {
		try {
			sourceRef.current?.disconnect()
		} catch {}
		sourceRef.current = null
		if (audioContextRef.current) {
			try {
				void audioContextRef.current.close()
			} catch {}
			audioContextRef.current = null
		}
	}, [])

	const handleStop = useCallback(() => {
		startPendingRef.current = false
		stop()
		cleanupAudioGraph()
		setSessionState('idle')
		setErrorMessage(null)
	}, [cleanupAudioGraph, stop])

	const handleStart = useCallback(async () => {
		if (startPendingRef.current) return
		startPendingRef.current = true
		setErrorMessage(null)
		setSessionState('requesting')
		try {
			await ensureAudioContext()
			await start({ instructions: defaultPrompt, voice: 'verse' })
			setSessionState('listening')
		} catch (error) {
			console.error('[lilac] unable to start session', error)
			const message =
				error instanceof Error
					? error.message
					: 'Something went wrong while requesting the microphone.'
			setErrorMessage(message)
			setSessionState('error')
			cleanupAudioGraph()
			stop()
		} finally {
			startPendingRef.current = false
		}
	}, [cleanupAudioGraph, ensureAudioContext, start, stop])

	useEffect(() => {
		if (!remoteStream) return cleanupAudioGraph

		let cancelled = false

		const connect = async () => {
			try {
				const ctx = await ensureAudioContext()
				if (!ctx || cancelled) return
				if (!remoteStream.getAudioTracks().length) {
					const handleAddTrack = () => {
						remoteStream.removeEventListener('addtrack', handleAddTrack as EventListener)
						void connect()
					}
					remoteStream.addEventListener('addtrack', handleAddTrack as EventListener)
					return
				}
				const node = ctx.createMediaStreamSource(remoteStream)
				try {
					sourceRef.current?.disconnect()
				} catch {}
				sourceRef.current = node
				node.connect(ctx.destination)
			} catch (error) {
				if (!cancelled) {
					console.error('[lilac] failed to wire remote audio', error)
				}
			}
		}

		void connect()

		return () => {
			cancelled = true
			cleanupAudioGraph()
		}
	}, [cleanupAudioGraph, ensureAudioContext, remoteStream])

	useEffect(() => {
		if (typeof document === 'undefined') return
		const handleVisibility = () => {
			if (document.visibilityState === 'hidden' && sessionState !== 'idle') {
				console.log('[lilac] document hidden -> stopping session')
				handleStop()
			}
		}
		document.addEventListener('visibilitychange', handleVisibility)
		return () => document.removeEventListener('visibilitychange', handleVisibility)
	}, [handleStop, sessionState])

	useEffect(() => {
		if (typeof window === 'undefined') return
		const handleBlur = () => {
			if (sessionState !== 'idle') {
				console.log('[lilac] window blur -> stopping session')
				handleStop()
			}
		}
		window.addEventListener('beforeunload', handleStop)
		window.addEventListener('blur', handleBlur)
		return () => {
			window.removeEventListener('beforeunload', handleStop)
			window.removeEventListener('blur', handleBlur)
		}
	}, [handleStop, sessionState])

	const statusText = useMemo(() => {
		if (sessionState === 'requesting') return 'Requesting microphone…'
		if (sessionState === 'listening') return 'Listening'
		if (sessionState === 'error') return errorMessage ?? 'Unable to start. Check microphone permissions.'
		return 'Tap start to begin listening.'
	}, [errorMessage, sessionState])

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
				className="absolute left-0 right-0 z-10 flex justify-between px-6 text-sm font-medium uppercase tracking-wide text-[var(--lilac-ink-muted)]"
				style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1.75rem)' }}
			>
				<span>Lilac</span>
				{isStandalone && <span>Home Screen</span>}
			</header>
			<div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-8 px-6 text-center">
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
				<div className="flex flex-col items-center gap-4">
					<button
						className="rounded-full bg-[var(--lilac-ink)] px-10 py-3 text-base font-semibold text-[var(--lilac-surface)] transition enabled:hover:bg-[var(--lilac-ink-muted)] disabled:cursor-not-allowed disabled:opacity-50"
						disabled={sessionState === 'requesting' || sessionState === 'listening'}
						onClick={handleStart}
					>
						{sessionState === 'requesting' ? 'Starting…' : 'Start listening'}
					</button>
					<button
						className="rounded-full border border-[var(--lilac-ink-muted)] px-6 py-2 text-sm font-medium text-[var(--lilac-ink-muted)] transition enabled:hover:border-[var(--lilac-ink)] enabled:hover:text-[var(--lilac-ink)] disabled:opacity-40"
						disabled={sessionState !== 'listening'}
						onClick={handleStop}
						type="button"
					>
						Stop
					</button>
				</div>
			</div>
			<footer
				className="absolute left-0 right-0 z-10 flex flex-col items-center gap-2 px-6 pb-10 text-xs font-medium uppercase tracking-[0.2em] text-[var(--lilac-ink-muted)]"
				style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.5rem)' }}
			>
				<span>{statusText}</span>
				{sessionState === 'error' && errorMessage ? (
					<span className="max-w-xs text-[0.65rem] normal-case tracking-normal text-[var(--lilac-ink-muted)]">
						{errorMessage}
					</span>
				) : null}
				{sessionState === 'idle' && (
					<span className="max-w-xs text-[0.65rem] normal-case tracking-normal text-[var(--lilac-ink-muted)]">
						{isStandalone
							? 'If the mic stops after reopening, tap Start again to refresh permissions.'
							: 'For a full-screen experience add Lilac to your home screen.'}
					</span>
				)}
			</footer>
		</div>
	)
}
