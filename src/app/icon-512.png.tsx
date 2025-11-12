import { ImageResponse } from 'next/og'

export const size = {
	height: 512,
	width: 512
}

export const contentType = 'image/png'

export default async function Icon() {
	return new ImageResponse(
		<div
			style={{
				alignItems: 'center',
				background: 'black',
				borderRadius: '64px',
				color: 'white',
				display: 'flex',
				fontSize: 320,
				fontWeight: 700,
				height: '100%',
				justifyContent: 'center',
				width: '100%'
			}}
		>
			L
		</div>,
		{
			...size
		}
	)
}
