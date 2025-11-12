import { createEnv } from '@t3-oss/env-nextjs'
import z from 'zod'

export default createEnv({
	experimental__runtimeEnv: {},
	server: {
		OPENAI_API_KEY: z.string().min(1)
	}
})
