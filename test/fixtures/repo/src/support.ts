import type { OpenAI } from 'openai'

// This is the call shape that stops working on 2026-11-30.
export async function triage(client: OpenAI, ticket: string, customerName: string) {
  return client.responses.create({
    prompt: { id: 'pmpt_abc', version: '2', variables: { customer_name: customerName } },
    input: ticket,
  })
}
