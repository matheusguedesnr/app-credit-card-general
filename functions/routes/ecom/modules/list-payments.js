exports.post = ({ appSdk }, req, res) => {
  const { /* params, */ application } = req.body
  // const { storeId } = req
  // setup basic required response object
  const response = {
    payment_gateways: []
  }
  // merge all app options configured by merchant
  const appData = Object.assign({}, application.data, application.hidden_data)

  /* DO THE STUFF HERE TO FILL RESPONSE OBJECT WITH PAYMENT GATEWAYS */

  const label = 'Pagamento com crédito'
  response.payment_gateways.push({
    type: 'payment',
    payment_method: {
      code: 'loyalty_points',
      name: label
    },
    label
  })

  response.loyalty_points_programs = {
    p0_pontos: {
      name: label,
      ratio: 1,
      min_subtotal_to_earn: 1,
      earn_percentage: 100
    }
  }

  res.send(response)
}
