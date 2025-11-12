import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import './styles.css'
import { RealtimeProvider } from '@/realtime/provider'

export const metadata: Metadata = {
	applicationName: 'Lilac Translate',
	description: 'A real-time voice translation app.',
	manifest: '/manifest.webmanifest',
	themeColor: [
		{ color: '#F7F3E7', media: '(prefers-color-scheme: light)' },
		{ color: '#27244C', media: '(prefers-color-scheme: dark)' }
	],
	title: {
		default: 'Lilac Translate',
		template: '%s · Lilac Translate'
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
			<body className="bg-neutral-100 text-neutral-900 antialiased">
				<RealtimeProvider>{children}</RealtimeProvider>
			</body>
		</html>
	)
}
