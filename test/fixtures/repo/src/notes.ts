import type { OpenAI } from 'openai'

export const RELEASE_NOTES_PROMPT = 'pmpt_def'

export async function releaseNotes(client: OpenAI, changelog: string) {
  return client.responses.create({
    prompt: { id: RELEASE_NOTES_PROMPT, variables: { changelog } },
  })
}
