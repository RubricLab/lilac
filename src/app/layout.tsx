import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import './styles.css'
import { RealtimeProvider } from '@/realtime/provider'

export const metadata: Metadata = {
	applicationName: 'Lilac Voice',
	description: 'A minimal PWA that connects to the OpenAI Realtime API over WebRTC.',
	manifest: '/manifest.webmanifest',
	themeColor: '#000000',
	title: {
		default: 'Lilac Voice',
		template: '%s · Lilac Voice'
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
