/* eslint-disable promise/no-nesting */
/* eslint-disable no-case-declarations */
// read configured E-Com Plus app data
const getAppData = require('../../lib/store-api/get-app-data')
const axios = require('axios')
const { getFirestore } = require('firebase-admin/firestore')
const SKIP_TRIGGER_NAME = 'SkipTrigger'
const ECHO_SUCCESS = 'SUCCESS'
const ECHO_SKIP = 'SKIP'
const ECHO_API_ERROR = 'STORE_API_ERR'
const { app } = require('firebase-admin')

exports.post = async ({ appSdk, admin }, req, res) => {
  // receiving notification from Store API
  const { storeId } = req

  /**
   * Treat E-Com Plus trigger body here
   * Ref.: https://developers.e-com.plus/docs/api/#/store/triggers/
   */
  const trigger = req.body
  appSdk.getAuth(storeId)
    .then((auth) => {
      // get app configured options
      getAppData({ appSdk, storeId, auth })

      .then(appData => {
        const { resource } = trigger
        let promise = Promise.resolve()
        console.log('Log trigger:', trigger.inserted_id || trigger.resource_id, resource)
        switch (resource) {
          case 'orders':
            let currentStatus
            if (trigger.body) {
              const orderId = trigger.resource_id || trigger.inserted_id
              return appSdk.apiRequest(storeId, `/orders/${orderId}.json`, 'GET', null, auth)

                .then(({ response }) => {
                  const order = response.data
                  currentStatus = order.financial_status && order.financial_status.current
                  let isPaid, isCancelled
                  isPaid = isCancelled = false
                  switch (currentStatus) {
                    case 'paid':
                      isPaid = true
                      break
                    case 'unauthorized':
                    case 'partially_refunded':
                    case 'refunded':
                    case 'voided':
                      isCancelled = true
                      break
                    case 'partially_paid':
                      if (order.transactions) {
                        order.transactions.forEach(transaction => {
                          if (transaction.payment_method.code !== 'loyalty_points' && transaction.status) {
                            switch (transaction.status.current) {
                              case 'unauthorized':
                              case 'refunded':
                              case 'voided':
                                isCancelled = true
                            }
                          }
                        })
                      }
                  }

                  if (isPaid || isCancelled) {
                    // get app configured options
                    const { amount, buyers, payment_method_label } = order
                    const customerId = buyers && buyers[0] && buyers[0]._id
                    if (customerId) {
                      const pointsEndpoint = `/customers/${customerId}/loyalty_points_entries`
                      return appSdk.apiRequest(storeId, `${pointsEndpoint}.json?order_id=${orderId}`)
                        .then(async ({ response }) => {
                          const pointsList = response.data.result
                          const hasEarnedPoints = pointsList.length > 0
                          /* if (isPaid && !hasEarnedPoints) {
                            const pointsValue = Math.floor((((amount.subtotal - (amount.discount || 0) - (amount.balance || 0)))))
                              const data = {
                                name: 'Pontos',
                                program_id: 'p0_pontos',
                                earned_points: pointsValue,
                                active_points: pointsValue,
                                ratio: rule.ratio || 1,
                                order_id: orderId
                              }
                              
                              const tryAddPoints = () => {
                                console.log(`POST ${JSON.stringify(data)} for #${storeId} ${customerId}`)
                                return appSdk.apiRequest(storeId, `${pointsEndpoint}.json`, 'POST', data).then(async () => {
                                  console.log('inserted point')
                                })
                              }

                              try {
                                await tryAddPoints()
                              } catch (error) {
                                console.log('error', error)
                                if (error.response && error.response.status === 403) {
                                  // delete older points entry and retry
                                  const findUrl = `${pointsEndpoint}.json` +
                                    `?valid_thru<=${(new Date().toISOString())}&sort=active_points&limit=1`
                                  await appSdk.apiRequest(storeId, findUrl).then(({ response }) => {
                                    const pointsList = response.data.result
                                    if (pointsList.length) {
                                      const endpoint = `${pointsEndpoint}/${pointsList[0]._id}.json`
                                      return appSdk.apiRequest(storeId, endpoint, 'DELETE').then(() => {
                                        return tryAddPoints()
                                      })
                                    }
                                  })
                                } else {
                                  throw error
                                }
                              }
                          } */

                          if (isCancelled && hasEarnedPoints) {
                            for (let i = 0; i < pointsList.length; i++) {
                              const pointsEntry = pointsList[i]
                              const endpoint = `${pointsEndpoint}/${pointsEntry._id}.json`
                              console.log(`DELETE ${endpoint} for #${storeId}`)
                              await appSdk.apiRequest(storeId, endpoint, 'DELETE').then(() => {
                                console.log('delete point')
                              })
                            }
                          }
                          return { order, customerId }
                        })

                        .then(async ({ order, customerId }) => {
                          console.log('client', customerId)
                          if (customerId && isCancelled) {
                            console.log('get in voided')
                            const documentRef = admin.firestore().doc(`billed_points/${orderId}`)
                            const documentSnapshot = await documentRef.get()
                            if (documentSnapshot.exists) {
                              const usedPointsEntries = documentSnapshot.get('usedPointsEntries')
                              documentRef.delete()
                              if (Array.isArray(usedPointsEntries)) {
                                for (let i = 0; i < usedPointsEntries.length; i++) {
                                  const pointsEntry = usedPointsEntries[i]
                                  const pointsToRefund = pointsEntry.original_active_points - pointsEntry.active_points
                                  if (pointsToRefund > 0) {
                                    const endpoint = `/customers/${customerId}/loyalty_points_entries/${pointsEntry._id}.json`
                                    let response
                                    try {
                                      const result = await appSdk.apiRequest(storeId, endpoint)
                                      response = result.response
                                    } catch (error) {
                                      if (!error.response || error.response.status !== 404) {
                                        throw error
                                      }
                                    }

                                    if (response) {
                                      const activePoints = response.data.active_points
                                      const data = {
                                        active_points: activePoints + pointsToRefund
                                      }
                                      await appSdk.apiRequest(storeId, endpoint, 'PATCH', data).then(() => {
                                        console.log('done')
                                      })
                                    }
                                  }
                                }

                                const transaction = order.transactions && order.transactions.find(transaction => {
                                  return transaction.payment_method.code === 'loyalty_points'
                                })
                                if (transaction) {
                                  const endpoint = `/orders/${orderId}/payments_history.json`
                                  const data = {
                                    transaction_id: transaction._id,
                                    date_time: new Date().toISOString(),
                                    status: currentStatus.startsWith('partially') ? 'refunded' : currentStatus,
                                    customer_notified: true
                                  }
                                  appSdk.apiRequest(storeId, endpoint, 'POST', data)
                                }
                              }
                            }
                          }
                          return null
                        })

                        .then(() => {
                          if (!res.headersSent) {
                            // nothing to do
                            res.sendStatus(204)
                          }
                        })
                    }


                      
                  }
                  // not paid nor cancelled
                  res.status(currentStatus ? 206 : 400).send(ECHO_SKIP)
                })

                .catch(err => {
                  if (err.name === SKIP_TRIGGER_NAME) {
                    // trigger ignored by app configuration
                    res.send(ECHO_SKIP)
                  } else {
                    console.error(err)
                    const { message, response } = err
                    if (!res.headersSent) {
                      // request to Store API with error response
                      // return error status code
                      const statusCode = response && (response.status === 401 || response.status === 403)
                        ? 203
                        : 500
                      res.status(statusCode).send({
                        error: ECHO_API_ERROR,
                        message
                      })
                    }
                  }
                })
            }
            break
          default:
            break;
        }

        return promise
      })

      .then(() => {
        console.log(`Trigger in ${trigger.resource} for #${storeId} successful`)
        if (!res.headersSent) {
          // nothing to do
          return res.send(ECHO_SUCCESS)
        }
      })

      .catch(err => {
        if (err.name === SKIP_TRIGGER_NAME) {
          // trigger ignored by app configuration
          res.send(ECHO_SKIP)
        } else {
          // request to Store API with error response
          // return error status code
          console.error(`[X] Trigger in ${trigger.resource} for #${storeId} failed`, err)
          const { response } = err
          if (response.data && response.data.errors) {
            console.error('[!] INFO: ', JSON.stringify(response.data.errors, undefined, 2))
          }

          if (response.data && response.data.detail) {
            console.error('[!] DETAIL: ', response.data)
          }

          res.status(500)
          const { message } = err
          res.send({
            error: ECHO_API_ERROR,
            message
          })
        }
      })
    })
}
