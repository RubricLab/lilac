import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
	return {
		background_color: '#ffffff',
		display: 'standalone',
		icons: [
			{
				purpose: 'maskable',
				sizes: '192x192',
				src: '/icon-192.png',
				type: 'image/png'
			},
			{
				purpose: 'maskable',
				sizes: '512x512',
				src: '/icon-512.png',
				type: 'image/png'
			}
		],
		id: '/',
		name: 'Lilac Voice',
		orientation: 'portrait-primary',
		scope: '/',
		short_name: 'Lilac',
		start_url: '/',
		theme_color: '#000000'
	}
}
