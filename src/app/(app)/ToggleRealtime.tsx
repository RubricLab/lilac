'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { useRealtimeVoiceSession } from '@/realtime/provider'

const defaultPrompt =
	'You are a translation assistant. When enabled, you will wait for everyone to introduce themselves, and take note of what language they speak. Then you will explain in all languages they speak that they can take turns speaking and you will translate for the other person or participants. Make sure to be helpful, concise and simple. You are helping people to learn and communicate with each other. Doing a really good job means getting out of the way and letting the conversation flow. So be helpful, but not intrusive, and always translate the meaning as closely as possible - to preserve accuracy and authenticity.'

export default function ToggleRealtime() {
	const { start, stop, remoteStream, updateInstructions, updateVoice } = useRealtimeVoiceSession()
	const [enabled, setEnabled] = useState(false)
	const [prompt, setPrompt] = useState(defaultPrompt)
	const [voice, setVoice] = useState('shimmer')
	const audioContextRef = useRef<AudioContext | null>(null)
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)

	const ensureAudioContext = useCallback(() => {
		const Ctx =
			window.AudioContext ??
			(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
		if (!Ctx) return
		if (!audioContextRef.current) {
			audioContextRef.current = new Ctx()
			console.log('[toggle] created AudioContext', { state: audioContextRef.current.state })
		}
		void audioContextRef.current.resume().then(() => {
			console.log('[toggle] AudioContext resumed', { state: audioContextRef.current?.state })
		})
	}, [])

	useEffect(() => {
		console.log('[toggle] remoteStream updated', {
			hasStream: Boolean(remoteStream),
			tracks: remoteStream?.getTracks().length
		})
		if (!remoteStream) return

		const hasAudio = () => remoteStream.getAudioTracks().length > 0

		const setup = () => {
			if (!hasAudio()) return
			console.log('[toggle] setting up WebAudio graph')
			if (!audioContextRef.current) {
				console.log('[toggle] AudioContext not ready yet')
				return
			}
			const ctx = audioContextRef.current
			if (ctx.state === 'suspended') {
				void ctx.resume().catch(() => {})
			}
			const src = ctx.createMediaStreamSource(remoteStream)
			sourceRef.current = src
			src.connect(ctx.destination)
		}

		if (hasAudio()) {
			setup()
		} else {
			const onAddTrack = () => {
				console.log('[toggle] remoteStream addtrack')
				try {
					setup()
				} finally {
					remoteStream.removeEventListener('addtrack', onAddTrack as EventListener)
				}
			}
			remoteStream.addEventListener('addtrack', onAddTrack as EventListener)
		}

		return () => {
			console.log('[toggle] cleaning audio graph')
			try {
				sourceRef.current?.disconnect()
			} catch {}
			try {
				audioContextRef.current?.close()
			} catch {}
			audioContextRef.current = null
			sourceRef.current = null
		}
	}, [remoteStream])

	useEffect(() => {
		console.log('[toggle] enabled changed', enabled)
		if (enabled) {
			ensureAudioContext()
			void start({ instructions: prompt, voice })
		} else {
			stop()
		}
	}, [enabled, prompt, voice, start, stop, ensureAudioContext])

	useEffect(() => {
		if (!enabled) return
		console.log('[toggle] updateInstructions', prompt.slice(0, 64))
		updateInstructions(prompt)
	}, [enabled, prompt, updateInstructions])

	useEffect(() => {
		if (!enabled) return
		console.log('[toggle] updateVoice', voice)
		updateVoice(voice)
	}, [enabled, voice, updateVoice])

	return (
		<div className="flex flex-col items-start gap-3">
			{/* <label className="flex w-full max-w-md flex-col gap-1 text-sm">
				<span className="text-neutral-600">System prompt</span>
				<input
					className="w-full rounded border border-neutral-300 px-3 py-2"
					onChange={e => setPrompt(e.target.value)}
					placeholder="You are a helpful assistant."
					value={prompt}
				/>
			</label> */}
			{/* <label className="flex w-full max-w-md flex-col gap-1 text-sm">
				<span className="text-neutral-600">Voice</span>
				<select
					className="w-full rounded border border-neutral-300 px-3 py-2"
					onChange={e => setVoice(e.target.value)}
					value={voice}
				>
					<option value="verse">verse</option>
					<option value="alloy">alloy</option>
					<option value="echo">echo</option>
					<option value="shimmer">shimmer</option>
				</select>
			</label> */}
			<label className="flex items-center gap-2 text-sm">
				<input checked={enabled} onChange={e => setEnabled(e.target.checked)} type="checkbox" />
				<span>Translate</span>
			</label>
		</div>
	)
}
