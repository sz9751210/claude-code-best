const GEMINI_WEB_URL = 'https://gemini.google.com/app'
const PLAYWRIGHT_MODULE = ['play', 'wright'].join('')

const INPUT_SELECTORS = [
  'textarea[aria-label*="Enter a prompt"]',
  'textarea[aria-label*="Message Gemini"]',
  'textarea',
  'div[contenteditable="true"][aria-label*="Enter a prompt"]',
  'div[contenteditable="true"][aria-label*="Message Gemini"]',
  'div[contenteditable="true"]',
]

const SEND_BUTTON_SELECTORS = [
  'button[aria-label*="Send message"]',
  'button[aria-label*="Send"]',
  'button:has-text("Send")',
]

const RESPONSE_SELECTORS = [
  'model-response',
  '[data-message-author-role="model"]',
  '[data-testid*="model-response"]',
  '.model-response',
  '.response-content',
]

const GENERATION_ACTIVE_SELECTORS = [
  'button[aria-label*="Stop generating"]',
  'button[aria-label*="Stop response"]',
  'button[aria-label*="Stop"]',
  '[data-testid*="stop"]',
  'mat-progress-bar',
  '.generating',
]

type PlaywrightPage = {
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<unknown>
  $: (selector: string) => Promise<unknown>
  isVisible: (selector: string) => Promise<boolean>
  fill: (selector: string, value: string) => Promise<unknown>
  click: (selector: string, options?: Record<string, unknown>) => Promise<unknown>
  keyboard: {
    press: (key: string) => Promise<unknown>
    insertText: (text: string) => Promise<unknown>
  }
  evaluate: <T, A>(fn: (arg: A) => T, arg: A) => Promise<T>
}

type PlaywrightContext = {
  pages: () => PlaywrightPage[]
  newPage: () => Promise<PlaywrightPage>
  close: () => Promise<unknown>
}

export type GeminiResponseState = {
  text: string
  generationActive: boolean
}

export class GeminiWebDomDriver {
  private context: PlaywrightContext | null = null
  private page: PlaywrightPage | null = null

  async ensureReady(): Promise<void> {
    if (this.page) {
      return
    }

    const { chromium } = (await import(PLAYWRIGHT_MODULE)) as {
      chromium: {
        launchPersistentContext: (
          userDataDir: string,
          options: Record<string, unknown>,
        ) => Promise<unknown>
      }
    }
    const context = (await chromium.launchPersistentContext(
      this.getProfileDir(),
      {
        headless: this.isHeadless(),
      },
    )) as unknown as PlaywrightContext

    const page = context.pages()[0] ?? (await context.newPage())

    this.context = context
    this.page = page

    await this.page.goto(GEMINI_WEB_URL, { waitUntil: 'domcontentloaded' })
    await this.page.waitForTimeout(750)
  }

  async sendPrompt(prompt: string): Promise<void> {
    await this.ensureReady()
    if (!this.page) {
      throw new Error('Gemini Web page is not ready')
    }

    const inputSelector = await this.findFirstVisibleSelector(INPUT_SELECTORS)
    if (!inputSelector) {
      throw new Error('Cannot find Gemini Web prompt input')
    }

    const inputHandle = await this.page.$(inputSelector)
    if (!inputHandle) {
      throw new Error('Gemini Web prompt input is not available')
    }

    const isTextarea = inputSelector.startsWith('textarea')
    if (isTextarea) {
      await this.page.fill(inputSelector, prompt)
    } else {
      await this.page.click(inputSelector, { timeout: 5000 })
      await this.page.keyboard.press(this.selectAllShortcut())
      await this.page.keyboard.press('Backspace')
      await this.page.keyboard.insertText(prompt)
    }

    const sendSelector = await this.findFirstVisibleSelector(
      SEND_BUTTON_SELECTORS,
    )
    if (sendSelector) {
      await this.page.click(sendSelector, { timeout: 3000 })
      return
    }

    await this.page.keyboard.press('Enter')
  }

  async readLatestResponseState(): Promise<GeminiResponseState> {
    await this.ensureReady()
    if (!this.page) {
      throw new Error('Gemini Web page is not ready')
    }

    return this.page.evaluate(
      ({
        responseSelectors,
        generationSelectors,
      }: {
        responseSelectors: string[]
        generationSelectors: string[]
      }) => {
        const isVisible = (el: Element): boolean => {
          const h = el as HTMLElement
          if (!h) return false
          const style = globalThis.getComputedStyle(h)
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            h.offsetParent !== null
          )
        }

        const texts: string[] = []
        for (const selector of responseSelectors) {
          const nodes = globalThis.document.querySelectorAll(selector)
          for (const node of nodes) {
            if (!isVisible(node)) {
              continue
            }
            const text = (node as HTMLElement).innerText?.trim() ?? ''
            if (text) {
              texts.push(text)
            }
          }
        }

        const text = texts.length > 0 ? texts[texts.length - 1]! : ''

        const generationActive = generationSelectors.some(selector => {
          const nodes = globalThis.document.querySelectorAll(selector)
          return Array.from(nodes).some(isVisible)
        })

        return { text, generationActive }
      },
      {
        responseSelectors: RESPONSE_SELECTORS,
        generationSelectors: GENERATION_ACTIVE_SELECTORS,
      },
    )
  }

  async close(): Promise<void> {
    if (!this.context) {
      return
    }
    await this.context.close()
    this.context = null
    this.page = null
  }

  private async findFirstVisibleSelector(
    selectors: string[],
  ): Promise<string | null> {
    if (!this.page) {
      return null
    }

    for (const selector of selectors) {
      try {
        if (await this.page.isVisible(selector)) {
          return selector
        }
      } catch {
        // Continue probing other selectors.
      }
    }
    return null
  }

  private getProfileDir(): string {
    return (
      process.env.GEMINI_WEB_PROFILE_DIR ||
      `${process.env.HOME || '~'}/.claude-code-haha/gemini-web-profile`
    )
  }

  private isHeadless(): boolean {
    const value = process.env.GEMINI_WEB_HEADLESS
    if (value === '0' || value === 'false') {
      return false
    }
    if (value === '1' || value === 'true') {
      return true
    }
    return true
  }

  private selectAllShortcut(): string {
    return process.platform === 'darwin' ? 'Meta+A' : 'Control+A'
  }
}
