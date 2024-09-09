import fs from 'node:fs/promises'
import path from 'node:path'

export async function getOrCreateTemplate(envFilePath: string): Promise<string> {
  const templatePath = path.join(path.dirname(envFilePath), 'template.handlebars')
  try {
    return await fs.readFile(templatePath, 'utf8')
  } catch (error) {
    // If file doesn't exist, create it with default content
    const defaultTemplate = `
Hello {{telegram}},

Great news! Your payout of {{amount}} {{currency}} for the {{pool_name}} pool has been sent and should arrive in your account shortly.

Transaction details:
- Amount: {{amount}} {{currency}}
- Order ID: {{orderId}}

Thank you for your investment!

Best regards,
The {{pool_name}} Team
    `.trim()

    await fs.writeFile(templatePath, defaultTemplate)
    return defaultTemplate
  }
}
