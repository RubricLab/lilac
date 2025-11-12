import { ImageResponse } from 'next/og'

export const alt = 'Create Rubric App'
export const size = {
	height: 630,
	width: 1200
}

export const contentType = 'image/png'

export default async function Image() {
	return new ImageResponse(
		<div
			style={{
				alignItems: 'center',
				background: 'white',
				display: 'flex',
				fontSize: 128,
				height: '100%',
				justifyContent: 'center',
				width: '100%'
			}}
		>
			R
		</div>,
		{
			...size
		}
	)
}
