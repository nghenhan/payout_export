import {Command, Flags} from '@oclif/core'
import Table from 'cli-table3'
import csv from 'csv-parser'
import fs from 'node:fs'
import path from 'node:path'
import {cwd} from 'node:process'
import {select, confirm} from '@inquirer/prompts'
import {ListrInquirerPromptAdapter} from '@listr2/prompt-adapter-inquirer'
import {delay, Listr} from 'listr2'
import Handlebars from 'handlebars'
import os from 'node:os'
import EnvFileManager from '../env-file-manager.js'
import {queryPayStatus, pay, getSpotBalance, getFundingBalance, universalTransfer} from '../binance.js'
import {notify} from '../notify.js'

export default class Execute extends Command {
  static description = `A cli to transfer payout to investors.
It contains multiple steps:
1. Scan & extract CSV
2. Verify your Binance account's fund
3. Transfer fund from your Binance Spot to Funding wallet
4. Binance Pay to each investor
5. Send notify messages
  `
  static examples = [`<%= config.bin %> --apiKey **** --secretKey **** --file path/to/csv/file`]

  static flags = {
    file: Flags.string({char: 'f', description: 'The path to CSV file', required: true}),
    currency: Flags.string({char: 'c', description: 'The currency to transfer', required: false, default: 'USDT'}),
    'api-key': Flags.string({description: 'Your Binance API Key', required: false}),
    'secret-key': Flags.string({description: 'Your Binance Secret Key', required: false}),
    'bpay-api-key': Flags.string({description: 'Your Binance Pay API Key', required: false}),
    'bpay-secret-key': Flags.string({description: 'Your Binance Pay Secret Key', required: false}),
  }

  static summary = 'Execute transfer payout to investors'

  async run(): Promise<void> {
    let exitCode = 0,
      hasOutput = false
    const envFileManager = new EnvFileManager('payout_execute')
    const {flags} = await this.parse(Execute)
    let {currency, 'api-key': pk, 'secret-key': sk, file, 'bpay-api-key': bpk, 'bpay-secret-key': bsk} = flags

    const envVals = await envFileManager.readEnvFile()

    pk ||= envVals['api-key']
    sk ||= envVals['secret-key']
    bpk ||= envVals['bpay-api-key']
    bsk ||= envVals['bpay-secret-key']

    if (!pk || !sk || !bpk || !bsk) {
      this.error('Some flags were not provided nor found in env file')
    }

    await envFileManager.writeEnvFile({
      currency,
      'api-key': pk,
      'secret-key': sk,
      'bpay-api-key': bpk,
      'bpay-secret-key': bsk,
    })
    this.log(`Env values updated at ${envFileManager.envFilePath}`)
    this.log('')

    const outputDataFileName = path.join(os.homedir(), `.payout_execute`, `output_${Date.now()}.json`)

    const logFileName = path.join(os.homedir(), `.payout_execute`, `history_${Date.now()}.log`)

    const logStream = fs.createWriteStream(path.resolve(cwd(), logFileName), {
      encoding: 'utf8',
    })

    function makeLog(level: 'info' | 'error') {
      return async function (msg: string) {
        const fmt = JSON.stringify({time: Date.now(), level, msg})

        return await new Promise<void>((r) => {
          logStream.write(fmt + '\n', (err) => !err && r())
        })
      }
    }

    async function end(msg: string) {
      return await new Promise<void>((r) => {
        const fmt = JSON.stringify({time: Date.now(), level: 'info', msg})
        logStream.end(fmt + '\n', () => r())
      })
    }

    const log = {
      info: makeLog('info'),
      error: makeLog('error'),
      end,
    }

    const ctx = {
      msgTemplate: '',
      botToken: '',
      transferAmount: '0',
      isTransferSpotToFunding: true,
      data: [] as {
        merchantSendId: string
        pool_name: string
        pool_slug: string
        round: number
        telegram: string
        binance_email: string
        amount: string
        chat_id: number
        status: 'SUCCESS' | 'FAIL' | 'AWAITING_RECEIPT' | null
        orderId: string | null
      }[],
      isContinue: true,
      currency,
      pk,
      sk,
      file,
      bpk,
      bsk,
    }

    try {
      const tasks = new Listr(
        [
          {
            title: 'Read CSV file',
            task: async (ctx, task) => {
              task.output = 'Loading file'
              const fullPath = path.resolve(cwd(), ctx.file)
              await log.info(`parse csv ${fullPath}`)
              await delay(1000)
              const table = new Table({
                head: ['Pool', 'Investor', 'Amount', 'Binance email'],
              })

              table.length = 0

              let data = []
              data = await new Promise<any[]>((r) => {
                const data: any[] = []
                fs.createReadStream(fullPath, {encoding: 'utf8'})
                  .on('error', async (e) => {
                    task.title = 'Read error: file not found'
                    await log.error(`parse csv failed ${fullPath}: ${e.message}`)
                    throw new Error(`FILE_NOT_FOUND: ${fullPath}`)
                  })
                  .pipe(csv())
                  .on('data', async (d) => {
                    data.push(d)
                    table.push([d.pool_name, d.telegram, d.amount, d.binance_email])

                    task.output = 'Reading rows'
                    await log.info(`read row ${JSON.stringify(d)}`)
                  })
                  .on('end', async () => {
                    task.output = 'Read OK, previewing...'
                    await delay(1000)
                    await log.error(`parse csv ok ${fullPath}: ${JSON.stringify(data)}`)
                    r(data)
                  })
              })

              const dateStr = new Date().toISOString()
              ctx.data = data.map((d) => ({
                ...d,
                orderId: null,
                status: null,
                merchantSendId: `TRANSFER_${d.email}_${dateStr}`,
              }))

              task.output = table.toString()

              ctx.isContinue = await task
                .prompt(ListrInquirerPromptAdapter)
                .run(confirm, {message: 'Continue?', default: true})

              await log.info(`end parse csv, continue ${ctx.isContinue}`)
            },
          },
          {
            title: `Check Binance Spot & Funding balance (${currency})`,
            skip: (ctx) => !ctx.isContinue,
            task: async (ctx, task) => {
              task.output = 'Calculating total'
              await delay(1000)
              let totalAmount = 0

              for (const [_i, d] of ctx.data.entries()) {
                totalAmount += Number(d.amount)
              }

              await log.info(`sum amount ${totalAmount}`)

              task.output = 'Getting account balance'

              const spotBalance = await getSpotBalance(ctx.currency, ctx.pk, ctx.sk).catch((e) => {
                log.error(`get spot balance failed ${e.message}`)
                return '0'
              })
              await log.info(`spot balance ${spotBalance}`)

              const fundingBalance = await getFundingBalance(ctx.currency, ctx.pk, ctx.sk).catch((e) => {
                log.error(`get funding balance failed ${e.message}`)
                return '0'
              })
              await log.info(`funding balance ${fundingBalance}`)

              await delay(1000)

              let col = 0

              for (let c of [spotBalance, fundingBalance]) {
                col = Math.max(c.length, col)
              }

              const balTable = new Table({
                chars: {
                  top: '',
                  'top-mid': '',
                  'top-left': '',
                  'top-right': '',
                  bottom: '',
                  'bottom-mid': '',
                  'bottom-left': '',
                  'bottom-right': '',
                  left: '',
                  'left-mid': '',
                  mid: '',
                  'mid-mid': '',
                  right: '',
                  'right-mid': '',
                  middle: ' ',
                },
                style: {'padding-left': 0, 'padding-right': 0},
              })

              balTable.push(
                [{content: '► Spot', hAlign: 'left'}, ':', {content: spotBalance, hAlign: 'right'}, ctx.currency],
                [{content: '► Funding', hAlign: 'left'}, ':', {content: fundingBalance, hAlign: 'right'}, ctx.currency],
              )

              task.output = `
Here is your current wallet balances

${balTable.toString()}

`

              if (Number(fundingBalance) >= totalAmount) {
                await log.info('show transfer option')
                ctx.isTransferSpotToFunding = false
                const selection = await task.prompt(ListrInquirerPromptAdapter).run(select, {
                  message: `There is enough balance in Funding to execute payout (need ${totalAmount}), do you still want to transfer Spot to Funding anyway?`,
                  choices: [
                    {
                      value: 'transfer_spot_funding',
                      name: 'Yes, transfer all Spot to Funding',
                    },
                    {
                      value: 'use_funding',
                      name: 'No, use current Funding balance',
                    },
                    {
                      value: 'exit',
                      name: 'Exit',
                    },
                  ],
                })

                ctx.isContinue = selection !== 'exit'
                ctx.isTransferSpotToFunding = selection === 'transfer_spot_funding'

                if (ctx.isTransferSpotToFunding) {
                  ctx.transferAmount = spotBalance
                }

                await log.info(`selected ${selection}`)
              } else if (Number(fundingBalance) + Number(spotBalance) < totalAmount) {
                task.output = "There isn't enough balance to execute payout, exiting..."
                await log.error('not enought balance to execute payout')
                throw new Error(
                  `NOT_ENOUGH_BALANCE: ${ctx.currency}, spot: ${spotBalance}, funding: ${fundingBalance}, need: ${totalAmount}`,
                )
              } else {
                ctx.isContinue = await task.prompt(ListrInquirerPromptAdapter).run(confirm, {
                  message: 'Transfer all Spot to Funding Y/n?',
                  default: true,
                })
              }

              await log.info(`end balance fetch, continue ${ctx.isContinue}`)
            },
          },
          {
            title: 'Spot to Funding',
            skip: (ctx) => !ctx.isContinue || !ctx.isTransferSpotToFunding,
            task: async (ctx, task) => {
              task.output = 'Transfering request'

              await log.info(`begin transfer spot to funding, amount ${ctx.transferAmount}`)
              let transferRes
              await delay(1000)
              transferRes = await universalTransfer(ctx.currency, ctx.transferAmount, ctx.pk, ctx.sk).catch((e) => {
                log.error(`transfer spot to funding failed ${e.message}`)
                return null
              })

              if (!transferRes) {
                throw new Error('TRANSFER_SPOT_FUNDING_ERROR')
              }

              await log.info(`transfer spot to funding ok transaction id ${transferRes.tranId}`)

              task.output = 'Transfer success'

              ctx.isContinue = await task.prompt(ListrInquirerPromptAdapter).run(confirm, {
                message: 'Execute payout?',
                default: true,
              })

              await log.info(`end transfer spot/funding, continue ${ctx.isContinue}`)
            },
          },
          {
            title: 'Execute payout',
            skip: (ctx) => !ctx.isContinue,
            task: async (ctx, task) => {
              task.output = 'Sending payout request'
              await delay(1000)
              await log.info('begin payout request')
              const poolName = ctx.data[0].pool_name
              const payoutRes = await pay({
                name: poolName,
                apiKey: ctx.bpk,
                apiSecret: ctx.bsk,
                currency,
                transferDetail: ctx.data.map((d) => ({
                  merchantSendId: d.merchantSendId,
                  email: d.binance_email,
                  amount: d.amount,
                })),
              }).catch((e) => {
                log.error(`payout request failed ${e.message}`)
                return null
              })

              if (!payoutRes) {
                throw new Error('PAYOUT_REQUEST_ERROR')
              }

              if (payoutRes.status === 'FAIL') {
                await log.error(`payout request failed ${payoutRes}`)
                throw new Error(`PAYOUT_REQUEST_ERROR: ${payoutRes.errorMessage}`)
              }

              task.output = 'Payout completed'

              await delay(1000)

              let attempt = 1

              task.output = `Querying transaction status`

              let isProcessed = false
              let responseDetail = null

              await log.info('query batch transaction')
              while (!isProcessed) {
                const status = await queryPayStatus(payoutRes.data.requestId, ctx.pk, ctx.sk).catch(() => {
                  log.error(`query tx status failed attempt #${attempt}`)
                  attempt++
                  return null
                })

                if (!status) {
                  await delay(2 * 60 * 1000) // wait 2 minutes
                  task.output = `Query failed, retrying after 2 min (attempt #${attempt})`
                } else if (
                  status.status === 'SUCCESS' &&
                  status.data.batchStatus !== 'ACCEPTED' &&
                  status.data.batchStatus !== 'PROCESSING'
                ) {
                  isProcessed = true
                  responseDetail = status.data
                }
              }

              if (
                !responseDetail ||
                responseDetail.batchStatus === 'PROCESSING' ||
                responseDetail.batchStatus === 'ACCEPTED'
              )
                throw new Error('BATCH_STILL_PROCESSING')

              task.output = 'Batch transaction processed'
              await delay(500)

              switch (responseDetail.batchStatus) {
                case 'SUCCESS':
                  await log.info('batch success')
                  task.output = 'Batch success'
                  break
                case 'FAILED':
                  await log.info('batch failed')
                  task.output = 'Batch failed'
                  break
                case 'PART_SUCCESS':
                  await log.info('batch part success')
                  task.output = 'Batch partially success, some recipients are not KYC yet to receive fund'
                  break
                case 'CANCELED':
                  await log.info('batch canceled')
                  task.output = 'Batch canceled by Binance'
                  break
                default:
                  break
              }

              await log.info('checking each investor transfer status')
              const table = new Table({
                head: ['Status', 'Pool', 'Investor', 'Amount', 'Binance email'],
              })

              for (const d of ctx.data) {
                const status = responseDetail.transferDetailList.find(
                  (tdl) => tdl.merchantSendId === d.merchantSendId,
                )?.status
                if (!status) throw new Error('INVESTOR_NOT_FOUND')

                d.status = status

                table.push([d.status, d.pool_name, d.telegram, d.amount, d.binance_email])
              }

              hasOutput = true

              await log.info(`investor status ${JSON.stringify(ctx.data)}`)

              task.output = table.toString()

              ctx.isContinue = await task.prompt(ListrInquirerPromptAdapter).run(confirm, {
                message: 'Notify investors?',
                default: true,
              })
            },
          },
          {
            title: 'Send notification',
            skip: (ctx) => !ctx.isContinue,
            task: async (ctx, task) => {
              task.output = 'Compiling message'
              await log.info('compile message')
              const template = Handlebars.compile(ctx.msgTemplate)

              const promises = []

              for (const d of ctx.data) {
                const msg = template(d)

                promises.push(notify(msg, d.chat_id, ctx.botToken))
              }

              await log.info('send message')

              const notiRes = await Promise.allSettled(promises)

              for (const res of notiRes) {
                if (res.status === 'rejected') {
                  await log.error(`error noti ${res.reason}`)
                }
              }

              task.output = 'Sent, notifications should show up soon'
            },
          },
        ],
        {
          ctx,
        },
      )

      await tasks.run()
    } catch (e) {
      exitCode = 1
    } finally {
      if (hasOutput) {
        await log.info('write output data')
        fs.writeFileSync(outputDataFileName, JSON.stringify(ctx.data, null, 2))
      }
      await log.end('all done')
      this.log(`All done
Detailed logs and generated data can be found at:

  ► ${logFileName}
  ${hasOutput ? `► ${outputDataFileName}` : ''}`)

      this.exit(exitCode)
    }
  }
}
