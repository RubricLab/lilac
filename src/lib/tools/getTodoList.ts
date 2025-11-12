import { createTool } from '@rubriclab/agents'
import z from 'zod/v4'

export default createTool({
	async execute() {
		return ''
	},
	schema: {
		input: z.object({}),
		output: z.string()
	}
})
