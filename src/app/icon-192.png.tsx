import { ImageResponse } from 'next/og'

export const size = {
	height: 192,
	width: 192
}

export const contentType = 'image/png'

export default async function Icon() {
	return new ImageResponse(
		<div
			style={{
				alignItems: 'center',
				background: 'black',
				borderRadius: '32px',
				color: 'white',
				display: 'flex',
				fontSize: 120,
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
