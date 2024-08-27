import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

class EnvFileManager {
  envFilePath: string

  constructor(cliName: string) {
    this.envFilePath = path.join(os.homedir(), `.${cliName}`, '.env')
  }

  private async ensureEnvFileExists() {
    try {
      await fs.access(this.envFilePath)
    } catch (error) {
      // File doesn't exist, so create it
      const dirPath = path.dirname(this.envFilePath)
      await fs.mkdir(dirPath, {recursive: true})
      await fs.writeFile(this.envFilePath, '')
    }
  }

  async readEnvFile() {
    await this.ensureEnvFileExists()
    const content = await fs.readFile(this.envFilePath, 'utf8')
    return content.split('\n').reduce((env, line) => {
      const [key, value] = line.split('=')
      if (key && value) {
        env[key.trim()] = value.trim()
      }
      return env
    }, {} as Record<string, any>)
  }

  async writeEnvFile(envData: Record<string, string | number | boolean>) {
    await this.ensureEnvFileExists()
    const content = Object.entries(envData)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
    await fs.writeFile(this.envFilePath, content)
  }
}
export default EnvFileManager
