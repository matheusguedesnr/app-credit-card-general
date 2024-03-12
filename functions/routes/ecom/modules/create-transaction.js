const { price: getPrice } = require('@ecomplus/utils')

exports.post = ({ appSdk, admin }, req, res) => {
  const { params, application } = req.body
  const { lang, items } = params
  const { storeId } = req
  // merge all app options configured by merchant
  const appData = Object.assign({}, application.data, application.hidden_data)
  // setup required `transaction` response object
  const transaction = {}

  /**
   * Do the stuff here, call external web service or just fill the `transaction` object
   * according to the `appData` configured options for the chosen payment method.
   */
  if (params.payment_method.code === 'loyalty_points') {
    const pointsApplied = params.loyalty_points_applied
    if (pointsApplied) {
      let pointsValue = pointsApplied.p0_pontos
      if (pointsValue > 0) {
        const ratio = 1

        transaction.loyalty_points = {
          name: 'Pagamento com crédito',
          program_id: 'p0_pontos',
          ratio,
          points_value: pointsValue
        }
        transaction.amount = pointsValue
      }
    }
  }

  if (transaction.amount) {
    const loyaltyPoints = transaction.loyalty_points
    const customerId = params.buyer.customer_id
    const orderId = params.order_id
    const usedPointsEntries = []

    return appSdk.apiRequest(storeId, `/customers/${customerId}.json`)
      .then(({ response }) => {
        const pointsEntries = response.data.loyalty_points_entries
        let pointsToConsume = loyaltyPoints.points_value
        if (pointsEntries) {
          pointsEntries.sort((a, b) => {
            return a.valid_thru < b.valid_thru
              ? -1
              : a.valid_thru > b.valid_thru ? 1 : 0
          })

          for (let i = 0; i < pointsEntries.length; i++) {
            if (pointsToConsume <= 0) {
              break
            }
            const pointsEntry = pointsEntries[i]
            if (pointsEntry.program_id === loyaltyPoints.program_id) {
              const validThru = pointsEntry.valid_thru
              const activePoints = pointsEntry.active_points
              if (activePoints > 0 && (!validThru || new Date(validThru).getTime() >= Date.now())) {
                const pointsDiff = activePoints - pointsToConsume
                if (pointsDiff > 0 && pointsDiff < 0.01) {
                  pointsToConsume = activePoints
                }
                if (pointsToConsume >= activePoints) {
                  pointsToConsume -= activePoints
                  pointsEntry.active_points = 0
                  if (pointsToConsume < 0.02) {
                    pointsToConsume = 0
                  }
                } else {
                  pointsEntry.active_points -= pointsToConsume
                  pointsToConsume = 0
                }
                usedPointsEntries.push({
                  ...pointsEntry,
                  original_active_points: activePoints
                })
              }
            }
          }

          if (pointsToConsume <= 0) {
            const updateTransactionStatus = () => {
              setTimeout(() => {
                appSdk.apiRequest(storeId, `/orders/${orderId}.json`).then(({ response }) => {
                  const { transactions } = response.data
                  if (transactions) {
                    const transaction = transactions.find(transaction => {
                      return transaction.payment_method.code === 'loyalty_points'
                    })
                    if (transaction) {
                      const endpoint = `/orders/${orderId}/payments_history.json`
                      const data = {
                        transaction_id: transaction._id,
                        date_time: new Date().toISOString(),
                        status: 'paid',
                        customer_notified: true
                      }
                      appSdk.apiRequest(storeId, endpoint, 'POST', data)
                    }
                  }
                })
              }, 500)
            }

            const collectionRef = admin.firestore().collection('billed_points')
            const handleUpdatedPoints = (timeout = 400, isLastRequest = false, endpoint, data) => {
              setTimeout(() => {
                appSdk.apiRequest(storeId, endpoint, 'PATCH', data).then(() => {
                  console.log(`#${storeId} ${orderId} ${endpoint} => ${JSON.stringify(data)}`)
                  if (isLastRequest) {
                    updateTransactionStatus()
                    collectionRef.doc(orderId).set({ usedPointsEntries })
                  }
                })
              }, timeout)
            }

            if (usedPointsEntries.length <= 3) {
              usedPointsEntries.forEach((pointsEntry, i) => {
                const endpoint = `/customers/${customerId}/loyalty_points_entries/${pointsEntry._id}.json`
                const data = {
                  active_points: pointsEntry.active_points
                }
                handleUpdatedPoints((i + 1) * 400, i + 1 === usedPointsEntries.length, endpoint, data)
              })
            } else {
              const endpoint = `/customers/${customerId}.json`
              const data = {
                loyalty_points_entries: pointsEntries
              }
              handleUpdatedPoints(400, true, endpoint, data)
            }
          }
        }

        transaction.status = {
          current: pointsToConsume <= 0 ? 'authorized' : 'unauthorized'
        }
        res.send({ transaction })
      })

      .catch(error => {
        // try to debug request error
        const errCode = 'POINTS_TRANSACTION_ERR'
        let { message } = error
        const err = new Error(`${errCode} #${storeId} - ${orderId} => ${message}`)
        if (error.response) {
          const { status, data } = error.response
          err.status = status
          if (status !== 401 && status !== 403) {
            if (typeof data === 'object' && data) {
              err.response = JSON.stringify(data)
            } else {
              err.response = data
            }
          }
          if (data && data.user_message) {
            message = data.user_message[lang] || data.user_message.en_us
          }
        }
        err.orderId = orderId
        err.usedPointsEntries = usedPointsEntries
        console.error(err)
        res.status(409).send({
          error: errCode,
          message
        })
      })
  }

  res.send({ transaction })
}
