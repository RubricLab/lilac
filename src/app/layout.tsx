import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import './styles.css'
import { RealtimeProvider } from '@/realtime/provider'

export const metadata: Metadata = {
	appleWebApp: {
		capable: true,
		statusBarStyle: 'black-translucent',
		title: 'Lilac'
	},
	applicationName: 'Lilac',
	description: 'A real-time voice translation app.',
	icons: {
		apple: [
			{ media: '(prefers-color-scheme: light)', sizes: '180x180', url: '/apple-icon.png' },
			{ media: '(prefers-color-scheme: dark)', sizes: '180x180', url: '/apple-icon-dark.png' }
		]
	},
	manifest: '/manifest.webmanifest',
	themeColor: [
		{ color: '#F7F3E7', media: '(prefers-color-scheme: light)' },
		{ color: '#27244C', media: '(prefers-color-scheme: dark)' }
	],
	title: {
		default: 'Lilac',
		template: '%s · Lilac'
	}
}

export const viewport: Viewport = {
	initialScale: 1,
	maximumScale: 1,
	minimumScale: 1,
	userScalable: false,
	viewportFit: 'cover'
}

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body className="min-h-svh bg-[var(--lilac-surface)] text-[var(--lilac-ink)] antialiased transition-colors">
				<RealtimeProvider>{children}</RealtimeProvider>
			</body>
		</html>
	)
}
