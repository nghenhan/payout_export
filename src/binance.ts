import crypto from 'crypto'
import ky from 'ky'

const BASE_BINANCE_PAY_API_URL = 'https://bpay.binanceapi.com'
const BASE_BINANCE_API_URL = 'https://api.binance.com'

function genNonce() {
  return crypto.randomBytes(32).toString('hex')
}

function genSigForPay(payload: any, timestamp: string, nonce: string, apiSecret: string) {
  const signaturePayload = timestamp + '\n' + nonce + '\n' + payload + '\n'
  return crypto.createHmac('sha512', apiSecret).update(signaturePayload).digest('hex')
}

function genSig(queryString: string, apiSecret: string) {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex')
}

interface PayoutParams {
  currency: string
  name: string
  transferDetail: {merchantSendId: string; email: string; amount: string}[]
  apiSecret: string
  apiKey: string
}

function makeQueryString(params: any) {
  return Object.keys(params)
    .map((key) => `${key}=${params[key]}`)
    .join('&')
}

export async function getSpotBalance(currency: string, apiKey: string, apiSecret: string) {
  const params: Record<string, any> = {}
  params.timestamp = Date.now()

  const queryString = makeQueryString(params)
  const signature = genSig(queryString, apiSecret)

  const fullQueryString = `${queryString}&signature=${signature}`

  const res = await ky
    .get<{balances: {asset: string; free: string}[]}>(
      BASE_BINANCE_API_URL + '/api/v3/account' + `?${fullQueryString}`,
      {
        headers: {
          'X-MBX-APIKEY': apiKey,
        },
      },
    )
    .json()

  return res.balances.find((b) => b.asset === currency)?.free || '0'
}

export async function getFundingBalance(currency: string, apiKey: string, apiSecret: string) {
  const params: Record<string, any> = {
    asset: currency,
  }
  params.timestamp = Date.now()

  const queryString = makeQueryString(params)
  const signature = genSig(queryString, apiSecret)

  const fullQueryString = `${queryString}&signature=${signature}`

  try {
    const res = await ky
      .post<{asset: string; free: string}[]>(
        BASE_BINANCE_API_URL + '/sapi/v1/asset/get-funding-asset' + `?${fullQueryString}`,
        {
          headers: {
            'X-MBX-APIKEY': apiKey,
          },
        },
      )
      .json()

    return res.find((b) => b.asset === currency)?.free || '0'
  } catch (e) {
    return '0'
  }
}

export async function universalTransfer(currency: string, amount: string, apiKey: string, apiSecret: string) {
  const params: Record<string, any> = {
    type: 'MAIN_FUNDING',
    asset: currency,
    amount,
  }
  params.timestamp = Date.now()

  const queryString = makeQueryString(params)
  const signature = genSig(queryString, apiSecret)

  const fullQueryString = `${queryString}&signature=${signature}`

  return await ky
    .post<{tranId: string}>(BASE_BINANCE_API_URL + '/sapi/v1/asset/transfer' + `?${fullQueryString}`, {
      headers: {
        'X-MBX-APIKEY': apiKey,
      },
    })
    .json()
}

export async function pay({name, currency, transferDetail, apiSecret, apiKey}: PayoutParams) {
  const endpoint = '/binancepay/openapi/payout/transfer'
  const nonce = genNonce()
  let totalAmount = 0

  for (const [_i, d] of transferDetail.entries()) {
    totalAmount += Number(d.amount)
  }

  const timestamp = Date.now()
  const dateStr = new Date().toISOString()

  const payload = JSON.stringify({
    requestId: 'BATCH_' + timestamp,
    bizScene: 'DIRECT_TRANSFER',
    batchName: name + ' ' + dateStr,
    currency,
    totalAmount: String(totalAmount),
    totalNumber: transferDetail.length,
    transferDetailList: transferDetail.map((td) => ({
      merchantSendId: td.merchantSendId,
      transferAmount: String(td.amount),
      transferMethod: 'FUNDING_WALLET',
      receiver: {
        identityType: 'EMAIL',
        identity: td.email,
      },
    })),
  })

  const signature = genSigForPay(payload, timestamp.toString(), nonce, apiSecret)

  return await ky
    .post<
      | {status: 'SUCCESS'; data: {requestId: string; status: 'ACCEPTED'}}
      | {status: 'FAIL'; code: string; errorMessage: string}
    >(BASE_BINANCE_PAY_API_URL + endpoint, {
      headers: {
        'content-type': 'application/json',
        'BinancePay-Timestamp': timestamp.toString(),
        'BinancePay-Nonce': nonce,
        'BinancePay-Certificate-SN': apiKey,
        'BinancePay-Signature': signature,
      },
      json: payload,
    })
    .json()
}

export async function queryPayStatus(requestId: string, apiKey: string, apiSecret: string) {
  const endpoint = '/binancepay/openapi/payout/query'
  const nonce = genNonce()

  const timestamp = Date.now()

  const payload = JSON.stringify({
    requestId,
    detailStatus: 'ALL',
  })

  const signature = genSigForPay(payload, timestamp.toString(), nonce, apiSecret)

  return await ky
    .post<
      | {
          status: 'SUCCESS'
          data: {
            batchStatus: 'ACCEPTED' | 'PROCESSING' | 'SUCCESS' | 'PART_SUCCESS' | 'FAILED' | 'CANCELED'
            transferDetailList: {
              orderId: string
              merchantSendId: string
              status: 'SUCCESS' | 'FAIL' | 'AWAITING_RECEIPT'
            }[]
          }
        }
      | {status: 'FAIL'; code: string; errorMessage: string}
    >(BASE_BINANCE_PAY_API_URL + endpoint, {
      headers: {
        'content-type': 'application/json',
        'BinancePay-Timestamp': timestamp.toString(),
        'BinancePay-Nonce': nonce,
        'BinancePay-Certificate-SN': apiKey,
        'BinancePay-Signature': signature,
      },
      json: payload,
    })
    .json()
}
