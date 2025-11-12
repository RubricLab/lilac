'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEventHandler } from 'react'

import { CORE_LANGUAGES, resolveLanguage, type LanguageInfo } from '@/lib/languages'
import { useRealtimeVoiceSession } from '@/realtime/provider'

const SYSTEM_PROMPT = `You are Lilac, a real-time interpreter that only facilitates communication.
- Translate every utterance faithfully and succinctly.
- Invite each person to introduce themselves once, then step back and only translate or call tools.
- Track participants by calling the provided tools. Add everyone who introduces themselves, keep their preferred language, and set an appropriate translation language.
- Offer concise setup instructions when absolutely necessary. Never drive the conversation, offer opinions, or add new topics.
- If you are uncertain about a name or language, ask briefly for clarification.`

const DEFAULT_VOICE = 'verse'

const BACKGROUND_LOOP_DURATION = 12

const PARTICIPANT_COLORS = [
        'from-white/80 to-white/40 dark:from-[#2d2958]/70 dark:to-[#221f40]/40',
        'from-white/70 to-white/30 dark:from-[#2c2a55]/65 dark:to-[#1e1a38]/35',
        'from-white/75 to-white/35 dark:from-[#302b5c]/70 dark:to-[#241f42]/35'
]

type Transform = {
        rotation: number
        x: number
        y: number
}

type ActivePointer = {
        currentX: number
        currentY: number
        id: number
        startX: number
        startY: number
}

type GestureState = {
        base: Transform
        gestureStart: {
                angle: number
                centroidX: number
                centroidY: number
                ids: [number, number]
        } | null
        pointers: Map<number, ActivePointer>
}

function useRemoteAudio(remoteStream: MediaStream | null) {
        const audioContextRef = useRef<AudioContext | null>(null)
        const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)

        const ensureAudioContext = useCallback(() => {
                if (audioContextRef.current) return audioContextRef.current
                const ContextCtor =
                        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
                if (!ContextCtor) return null
                const ctx = new ContextCtor()
                audioContextRef.current = ctx
                void ctx.resume().catch(() => undefined)
                return ctx
        }, [])

        useEffect(() => {
                if (!remoteStream) return
                const ctx = ensureAudioContext()
                if (!ctx) return
                const hasAudio = remoteStream.getAudioTracks().length > 0

                const setupGraph = () => {
                        if (!audioContextRef.current) return
                        const src = audioContextRef.current.createMediaStreamSource(remoteStream)
                        sourceRef.current = src
                        src.connect(audioContextRef.current.destination)
                }

                if (hasAudio) {
                        setupGraph()
                } else {
                        const onAddTrack = () => {
                                setupGraph()
                                remoteStream.removeEventListener('addtrack', onAddTrack as EventListener)
                        }
                        remoteStream.addEventListener('addtrack', onAddTrack as EventListener)
                }

                return () => {
                        try {
                                sourceRef.current?.disconnect()
                        } catch {}
                        sourceRef.current = null
                }
        }, [ensureAudioContext, remoteStream])

        useEffect(() => {
                return () => {
                        try {
                                sourceRef.current?.disconnect()
                        } catch {}
                        try {
                                audioContextRef.current?.close()
                        } catch {}
                        audioContextRef.current = null
                        sourceRef.current = null
                }
        }, [])

        return ensureAudioContext
}

function createInitialTransform(): Transform {
        if (typeof window === 'undefined') {
                return { rotation: 0, x: 0, y: 0 }
        }
        const width = window.innerWidth
        const height = window.innerHeight
        const radiusX = Math.min(width, 520) / 3
        const radiusY = Math.min(height, 520) / 3
        return {
                rotation: (Math.random() - 0.5) * 8,
                x: (Math.random() - 0.5) * radiusX,
                y: (Math.random() - 0.5) * radiusY
        }
}

function ParticipantBubble({
        colorIndex,
        languageOptions,
        onTargetLanguageChange,
        onTransform,
        participant,
        transform
}: {
        colorIndex: number
        languageOptions: LanguageInfo[]
        onTargetLanguageChange: (language: string | null) => void
        onTransform: (transform: Transform) => void
        participant: {
                id: string
                name: string
                primaryLanguage: string
                targetLanguage: string | null
        }
        transform: Transform
}) {
        const gestureRef = useRef<GestureState | null>(null)

        useEffect(() => {
                if (!gestureRef.current) return
                gestureRef.current.base = transform
        }, [transform])

        const applySinglePointer = useCallback(
                (state: GestureState) => {
                        const iterator = state.pointers.values().next()
                        const pointer = iterator.value
                        if (!pointer) return
                        const deltaX = pointer.currentX - pointer.startX
                        const deltaY = pointer.currentY - pointer.startY
                        onTransform({
                                rotation: state.base.rotation,
                                x: state.base.x + deltaX,
                                y: state.base.y + deltaY
                        })
                },
                [onTransform]
        )

        const applyMultiPointer = useCallback(
                (state: GestureState) => {
                        const pointers = Array.from(state.pointers.values())
                        if (pointers.length < 2) return
                        const [first, second] = pointers
                        if (!first || !second) return
                        if (!state.gestureStart || state.gestureStart.ids[0] !== first.id || state.gestureStart.ids[1] !== second.id) {
                                state.gestureStart = {
                                        angle: Math.atan2(second.currentY - first.currentY, second.currentX - first.currentX),
                                        centroidX: (first.currentX + second.currentX) / 2,
                                        centroidY: (first.currentY + second.currentY) / 2,
                                        ids: [first.id, second.id]
                                }
                                state.base = transform
                                pointers.forEach(pointer => {
                                        pointer.startX = pointer.currentX
                                        pointer.startY = pointer.currentY
                                })
                        }
                        if (!state.gestureStart) return
                        const centroidX = (first.currentX + second.currentX) / 2
                        const centroidY = (first.currentY + second.currentY) / 2
                        const angle = Math.atan2(second.currentY - first.currentY, second.currentX - first.currentX)
                        const deltaX = centroidX - state.gestureStart.centroidX
                        const deltaY = centroidY - state.gestureStart.centroidY
                        const deltaAngle = ((angle - state.gestureStart.angle) * 180) / Math.PI
                        onTransform({
                                rotation: state.base.rotation + deltaAngle,
                                x: state.base.x + deltaX,
                                y: state.base.y + deltaY
                        })
                },
                [onTransform, transform]
        )

        const handlePointerDown = useCallback<PointerEventHandler<HTMLDivElement>>(
                event => {
                        event.preventDefault()
                        const element = event.currentTarget
                        element.setPointerCapture(event.pointerId)
                        gestureRef.current ??= {
                                base: transform,
                                gestureStart: null,
                                pointers: new Map()
                        }
                        const state = gestureRef.current
                        state.base = transform
                        state.pointers.set(event.pointerId, {
                                currentX: event.clientX,
                                currentY: event.clientY,
                                id: event.pointerId,
                                startX: event.clientX,
                                startY: event.clientY
                        })
                        if (state.pointers.size === 2) {
                                state.gestureStart = null
                        }
                },
                [transform]
        )

        const handlePointerMove = useCallback<PointerEventHandler<HTMLDivElement>>(
                event => {
                        const state = gestureRef.current
                        if (!state) return
                        const pointer = state.pointers.get(event.pointerId)
                        if (!pointer) return
                        pointer.currentX = event.clientX
                        pointer.currentY = event.clientY

                        if (state.pointers.size === 1) {
                                applySinglePointer(state)
                                return
                        }
                        if (state.pointers.size >= 2) {
                                applyMultiPointer(state)
                        }
                },
                [applyMultiPointer, applySinglePointer]
        )

        const handlePointerEnd = useCallback<PointerEventHandler<HTMLDivElement>>(
                event => {
                        const state = gestureRef.current
                        if (!state) return
                        state.pointers.delete(event.pointerId)
                        if (state.pointers.size === 0) {
                                gestureRef.current = null
                                return
                        }
                        if (state.pointers.size === 1) {
                                const iterator = state.pointers.values().next()
                                const remaining = iterator.value
                                if (remaining) {
                                        remaining.startX = remaining.currentX
                                        remaining.startY = remaining.currentY
                                }
                                state.base = transform
                                state.gestureStart = null
                        }
                },
                [transform]
        )

        const primaryLanguage = resolveLanguage(participant.primaryLanguage)
        const translationLanguage = resolveLanguage(participant.targetLanguage)
        const selectValue = participant.targetLanguage ?? ''
        const hasSelectValue =
                selectValue === '' || languageOptions.some(option => option.code === selectValue)

        const gradientClass = useMemo(
                () => PARTICIPANT_COLORS[colorIndex % PARTICIPANT_COLORS.length],
                [colorIndex]
        )

        return (
                <div
                        className="absolute left-1/2 top-1/2 touch-none"
                        onPointerCancel={handlePointerEnd}
                        onPointerDown={handlePointerDown}
                        onPointerLeave={handlePointerEnd}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerEnd}
                        onPointerOut={handlePointerEnd}
                        style={{
                                transform: `translate3d(-50%, -50%, 0) translate3d(${transform.x}px, ${transform.y}px, 0) rotate(${transform.rotation}deg)`
                        }}
                >
                        <motion.div
                                animate={{ y: [0, -6, 0] }}
                                transition={{ duration: BACKGROUND_LOOP_DURATION, repeat: Infinity, ease: 'easeInOut' }}
                                className={`pointer-events-auto select-none rounded-3xl border border-white/20 px-6 py-5 shadow-xl shadow-black/5 backdrop-blur-xl ${gradientClass}`}
                        >
                                <div className="text-base font-semibold tracking-tight text-[#241b3b] dark:text-[#f0e7ff]">
                                        {participant.name}
                                </div>
                                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.3em] text-[#5d5573] dark:text-[#cdc4ef]">
                                        <span className="rounded-full bg-white/40 px-3 py-1 text-[#39304d] shadow-sm dark:bg-white/10 dark:text-[#f5f0ff]">
                                                {primaryLanguage?.name ?? participant.primaryLanguage.toUpperCase()}
                                        </span>
                                        <span className="text-[#8d83a8] dark:text-[#c1b8e6]">→</span>
                                        <label className="relative">
                                                <span className="sr-only">Translation language</span>
                                                <select
                                                        className="appearance-none rounded-full bg-white/60 px-3 py-1 pr-8 text-[#2c2444] shadow-inner shadow-white/40 transition focus:outline-none focus:ring-2 focus:ring-[#b6a2ff]/60 dark:bg-white/10 dark:text-[#f7f4ff] dark:shadow-black/20"
                                                        onChange={event =>
                                                                onTargetLanguageChange(
                                                                        event.target.value ? event.target.value : null
                                                                )
                                                        }
                                                        value={selectValue}
                                                >
                                                        <option value="">Auto</option>
                                                        {languageOptions.map(option => (
                                                                <option key={option.code} value={option.code}>
                                                                        {option.name}
                                                                </option>
                                                        ))}
                                                        {!hasSelectValue && selectValue ? (
                                                                <option value={selectValue}>{selectValue.toUpperCase()}</option>
                                                        ) : null}
                                                </select>
                                                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[#8d83a8] dark:text-[#c1b8e6]">
                                                        ⌄
                                                </span>
                                        </label>
                                </div>
                                {translationLanguage ? (
                                        <div className="mt-2 text-xs tracking-wide text-[#6b6186] dark:text-[#d1c7f0]">
                                                Translations in {translationLanguage.name}
                                        </div>
                                ) : (
                                        <div className="mt-2 text-xs tracking-wide text-[#6b6186] dark:text-[#d1c7f0]">
                                                Following the conversation
                                        </div>
                                )}
                        </motion.div>
                </div>
        )
}

export default function LilacExperience() {
        const {
                participants,
                remoteStream,
                setParticipantTargetLanguage,
                start,
                stop
        } = useRealtimeVoiceSession()
        const ensureAudioContext = useRemoteAudio(remoteStream)
        const [started, setStarted] = useState(false)
        const [languageOrder, setLanguageOrder] = useState<LanguageInfo[]>(() => [...CORE_LANGUAGES])
        const [currentIndex, setCurrentIndex] = useState(0)
        const [transforms, setTransforms] = useState<Record<string, Transform>>({})
        const startOnceRef = useRef(false)

        useEffect(() => {
                if (typeof navigator === 'undefined') return
                const navLanguages = navigator.languages ?? (navigator.language ? [navigator.language] : [])
                if (!navLanguages.length) return
                const prioritizedCodes = navLanguages
                        .map(code => code?.toLowerCase()?.split('-')[0])
                        .filter(Boolean) as string[]
                if (!prioritizedCodes.length) return
                setLanguageOrder(() => {
                        const seen = new Set<string>()
                        const ordered: LanguageInfo[] = []
                        const pushLanguage = (code: string) => {
                                const language = CORE_LANGUAGES.find(item => item.code === code)
                                if (!language || seen.has(language.code)) return
                                seen.add(language.code)
                                ordered.push(language)
                        }
                        for (const code of prioritizedCodes) pushLanguage(code)
                        for (const language of CORE_LANGUAGES) {
                                if (!seen.has(language.code)) {
                                        seen.add(language.code)
                                        ordered.push(language)
                                }
                        }
                        return ordered
                })
                setCurrentIndex(0)
        }, [])

        useEffect(() => {
                if (startOnceRef.current) return
                startOnceRef.current = true
                const begin = async () => {
                        try {
                                ensureAudioContext()
                                await start({ instructions: SYSTEM_PROMPT, voice: DEFAULT_VOICE })
                                setStarted(true)
                        } catch (error) {
                                console.error('Failed to start realtime session', error)
                        }
                }
                void begin()

                return () => {
                        void stop()
                }
        }, [ensureAudioContext, start, stop])

        useEffect(() => {
                const interval = window.setInterval(() => {
                        setCurrentIndex(prev => {
                                if (languageOrder.length === 0) return prev
                                return (prev + 1) % languageOrder.length
                        })
                }, 3600)
                return () => window.clearInterval(interval)
        }, [languageOrder.length])

        useEffect(() => {
                setTransforms(prev => {
                        const next: Record<string, Transform> = { ...prev }
                        let changed = false
                        for (const participant of participants) {
                                if (!next[participant.id]) {
                                        next[participant.id] = createInitialTransform()
                                        changed = true
                                }
                        }
                        for (const id of Object.keys(next)) {
                                if (!participants.some(participant => participant.id === id)) {
                                        delete next[id]
                                        changed = true
                                }
                        }
                        return changed ? next : prev
                })
        }, [participants])

        const activeLanguage = languageOrder.length
                ? languageOrder[currentIndex % languageOrder.length]
                : CORE_LANGUAGES[0]

        const participantList = useMemo(() => participants.map(participant => participant), [participants])

        return (
                <main className="relative flex min-h-screen flex-col items-center justify-between overflow-hidden bg-lilac-surface px-6 pb-16 pt-24 text-[#201836] dark:text-[#f6f1ff]">
                        <div className="pointer-events-none absolute inset-0 -z-10 bg-lilac-radiance" />
                        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-64 bg-gradient-to-b from-white/60 to-transparent dark:from-[#1f1a38]/70" />
                        <div className="flex w-full max-w-4xl flex-1 flex-col items-center gap-20">
                                <div className="flex flex-col items-center gap-6 text-center">
                                        <span className="text-xs uppercase tracking-[0.6em] text-[#8f86a8] dark:text-[#c9c2e6]">Lilac translate</span>
                                        <AnimatePresence mode="wait" initial={false}>
                                                {activeLanguage ? (
                                                        <motion.div
                                                                key={activeLanguage.code}
                                                                animate={{ opacity: 1, y: 0 }}
                                                                exit={{ opacity: 0, y: -18 }}
                                                                initial={{ opacity: 0, y: 18 }}
                                                                transition={{ duration: 0.8, ease: 'easeOut' }}
                                                                className="space-y-4"
                                                        >
                                                                <motion.h1 className="text-4xl font-semibold leading-tight tracking-tight text-[#241b3b] dark:text-[#f4eeff] sm:text-5xl">
                                                                        {activeLanguage.introduceYourself}
                                                                </motion.h1>
                                                                <p className="text-sm uppercase tracking-[0.35em] text-[#9286b0] dark:text-[#bdb2de]">
                                                                        {activeLanguage.name}
                                                                </p>
                                                        </motion.div>
                                                ) : null}
                                        </AnimatePresence>
                                        <p className="max-w-md text-sm leading-relaxed text-[#6d6386] dark:text-[#cbc2e7]">
                                                {started
                                                        ? 'Lilac is listening. Introduce yourself and we will take care of the translations.'
                                                        : 'Preparing the space… allow microphone access to begin instant translation.'}
                                        </p>
                                </div>
                                <div className="relative w-full max-w-4xl flex-1">
                                        <div className="absolute inset-0" aria-live="polite">
                                                {participantList.length === 0 ? (
                                                        <div className="flex h-full flex-col items-center justify-center gap-4 text-center text-sm text-[#756b8f] dark:text-[#c9bff0]">
                                                                <div className="rounded-full border border-white/40 bg-white/50 px-4 py-2 text-xs uppercase tracking-[0.3em] text-[#9a90b8] shadow-inner dark:border-white/10 dark:bg-white/10 dark:text-[#d9cff6]">
                                                                        Waiting for introductions
                                                                </div>
                                                                <p className="max-w-xs leading-relaxed">
                                                                        When someone speaks, their name and languages will appear here. Pinch with two fingers to place their bubble wherever you need it.
                                                                </p>
                                                        </div>
                                                ) : null}
                                                {participantList.map((participant, index) => (
                                                        <ParticipantBubble
                                                                key={participant.id}
                                                                colorIndex={index}
                                                                languageOptions={languageOrder}
                                                                onTargetLanguageChange={language =>
                                                                        setParticipantTargetLanguage(participant.id, language)
                                                                }
                                                                onTransform={value =>
                                                                        setTransforms(prev => ({
                                                                                ...prev,
                                                                                [participant.id]: value
                                                                        }))
                                                                }
                                                                participant={participant}
                                                                transform={transforms[participant.id] ?? { rotation: 0, x: 0, y: 0 }}
                                                        />
                                                ))}
                                        </div>
                                </div>
                        </div>
                </main>
        )
}
