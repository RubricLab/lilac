'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useRealtimeVoiceSession } from '@/realtime/provider'

const customInstructionsToken = '{{CUSTOM_INSTRUCTIONS}}'

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

Your sole job is to provide fast, faithful translations that keep the conversation flowing.

Custom instructions (these are optionally added by the user in a settings UI to augment and personalize the experience):
${customInstructionsToken}
-- End custom instructions --`

const buildPrompt = (custom: string) =>
	defaultPrompt.replace(customInstructionsToken, custom.trim() || 'None provided.')

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

const saveButtonClasses = [
	'bg-[var(--lilac-ink)]',
	'focus-visible:outline',
	'focus-visible:outline-2',
	'focus-visible:outline-offset-2',
	'focus-visible:outline-white',
	'hover:shadow-lg',
	'px-4',
	'py-2',
	'rounded-full',
	'shadow-md',
	'text-[var(--lilac-surface)]',
	'transition'
].join(' ')

type ConnectionState = 'idle' | 'requesting' | 'ready' | 'error'

export default function ToggleRealtime() {
	const { start, stop, remoteStream, updateInstructions } = useRealtimeVoiceSession()
	const [connectionState, setConnectionState] = useState<ConnectionState>('idle')
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [languageOrder, setLanguageOrder] = useState(languagePhrases)
	const [tab, setTab] = useState<'session' | 'settings'>('session')
	const [customInstructions, setCustomInstructions] = useState('')
	const [draftInstructions, setDraftInstructions] = useState('')
	const [saveConfirmation, setSaveConfirmation] = useState('')
	const audioContextRef = useRef<AudioContext | null>(null)
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
	const startedRef = useRef(false)
	const cancelInitRef = useRef(false)

	const instructionsText = useMemo(() => buildPrompt(customInstructions), [customInstructions])

	useEffect(() => {
		if (typeof window === 'undefined') return
		const stored = window.localStorage.getItem('lilac.customInstructions')
		if (stored !== null) {
			setCustomInstructions(stored)
			setDraftInstructions(stored)
		}
	}, [])

	useEffect(() => {
		if (!saveConfirmation) return
		const timer = window.setTimeout(() => setSaveConfirmation(''), 1800)
		return () => {
			window.clearTimeout(timer)
		}
	}, [saveConfirmation])

	useEffect(() => {
		if (typeof window === 'undefined') return
		window.localStorage.setItem('lilac.customInstructions', customInstructions)
		updateInstructions(instructionsText)
	}, [customInstructions, instructionsText, updateInstructions])

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
			await start({ instructions: instructionsText, voice: 'verse' })
			if (cancelInitRef.current) {
				startedRef.current = false
				return
			}
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
	}, [ensureAudioContext, start, instructionsText])

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
	const footerText = tab === 'session' ? statusText : ''

	const content =
		tab === 'session' ? (
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
		) : (
			<div className="flex w-full max-w-xl flex-col gap-4 text-left">
				<div className="rounded-3xl border border-white/30 bg-[var(--lilac-elevated)] p-5 text-[var(--lilac-ink)] shadow-xl backdrop-blur">
					<div className="mb-3 font-semibold text-base tracking-tight">Custom instructions</div>
					<textarea
						className="h-40 w-full resize-none rounded-2xl border border-white/30 bg-white/70 px-4 py-3 text-[var(--lilac-ink)] text-base outline-none ring-0 transition focus:border-white/70 focus:bg-white dark:bg-white/10 dark:focus:border-white/30 dark:focus:bg-white/20"
						onChange={event => setDraftInstructions(event.target.value)}
						placeholder="Tell Lilac how to behave."
						value={draftInstructions}
					/>
					<div className="mt-3 flex justify-end gap-2 font-semibold text-sm">
						<button
							type="button"
							className="cursor-pointer rounded-full px-4 py-2 text-[var(--lilac-ink-muted)] transition hover:bg-white/40 dark:hover:bg-white/10"
							onClick={() => setDraftInstructions(customInstructions)}
						>
							Reset
						</button>
						<button
							type="button"
							className={`${saveButtonClasses} cursor-pointer`}
							onClick={() => {
								setCustomInstructions(draftInstructions.trim())
								setSaveConfirmation('Custom instructions saved')
							}}
						>
							Save
						</button>
					</div>
					{saveConfirmation ? (
						<output className="mt-2 block text-[var(--lilac-ink-muted)] text-xs" aria-live="polite">
							{saveConfirmation}
						</output>
					) : null}
				</div>
				<p className="px-1 text-[var(--lilac-ink-muted)] text-sm">
					Custom instructions are stored locally on this device.
				</p>
			</div>
		)

	return (
		<div className="relative box-border flex h-svh flex-col overflow-hidden">
			<div className="-z-10 pointer-events-none absolute inset-0 bg-[radial-gradient(220%_200%_at_50%_-12%,rgba(255,255,255,0.95)_0%,rgba(247,243,231,0.98)_48%,rgba(247,243,231,1)_72%,rgba(206,190,255,0.6)_100%)] dark:bg-[radial-gradient(220%_200%_at_50%_-12%,rgba(40,31,61,0.95)_0%,rgba(24,18,38,0.98)_50%,rgba(24,18,38,1)_74%,rgba(89,70,120,0.65)_100%)]" />
			<div className="-z-10 pointer-events-none absolute inset-x-0 top-0 h-[28dvh] bg-gradient-to-b from-white/65 via-transparent to-transparent dark:from-[#2d2248]/60 dark:via-transparent" />
			<div className="-z-10 pointer-events-none absolute inset-x-0 bottom-0 h-[32dvh] bg-gradient-to-t from-[var(--lilac-surface)] via-transparent to-transparent dark:from-[#120c1e] dark:via-transparent" />
			<header
				className="absolute right-0 left-0 z-20 flex items-center justify-between px-6 font-medium text-[var(--lilac-ink-muted)] text-sm uppercase tracking-wide"
				style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1.75rem)' }}
			>
				<span>Lilac</span>
				<div
					className="flex rounded-full bg-[var(--lilac-elevated)] p-1 font-semibold text-xs uppercase tracking-[0.08em] shadow-sm backdrop-blur"
					role="tablist"
				>
					<button
						type="button"
						aria-pressed={tab === 'session'}
						className={`cursor-pointer rounded-full px-3 py-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2 ${
							tab === 'session'
								? 'bg-white text-[var(--lilac-surface)] shadow'
								: 'text-[var(--lilac-ink-muted)] hover:text-[var(--lilac-ink)]'
						}`}
						onClick={() => setTab('session')}
					>
						Chat
					</button>
					<button
						type="button"
						aria-pressed={tab === 'settings'}
						className={`cursor-pointer rounded-full px-3 py-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2 ${
							tab === 'settings'
								? 'bg-white text-[var(--lilac-surface)] shadow'
								: 'text-[var(--lilac-ink-muted)] hover:text-[var(--lilac-ink)]'
						}`}
						onClick={() => setTab('settings')}
					>
						Settings
					</button>
				</div>
			</header>
			<div className="relative z-10 flex flex-1 items-center justify-center px-6 text-center">
				{content}
			</div>
			{footerText ? (
				<footer
					className="absolute right-0 left-0 z-10 flex justify-center px-6 font-medium text-[var(--lilac-ink-muted)] text-xs uppercase tracking-[0.2em]"
					style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 2rem)' }}
				>
					<span>{footerText}</span>
				</footer>
			) : null}
		</div>
	)
}
