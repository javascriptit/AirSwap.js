import _ from 'lodash'
import * as ethers from 'ethers'
import { abis, SWAP_LEGACY_CONTRACT_ADDRESS, SWAP_CONTRACT_ADDRESS, ERC20abi } from '../../constants'
import { makeEventActionTypes, makeEventFetchingActionsCreators } from '../../utils/redux/templates/event'
import { selectors as blockTrackerSelectors } from '../../blockTracker/redux'
import { selectors as deltaBalancesSelectors } from '../../deltaBalances/redux'
import { selectors as eventSelectors } from './reducers'

import * as gethRead from '../../utils/gethRead'
import {
  buildGlobalERC20TransfersTopics,
  fetchLogs,
  fetchFilledExchangeLogsForMakerAddress,
  fetchCanceledExchangeLogsForMakerAddress,
  fetchFailedExchangeLogsForMakerAddress,
  fetchSwapFillsForMakerAddress,
  fetchSwapCancelsForMakerAddress,
} from '../index'
import { gotBlocks } from '../../blockTracker/redux/actions'

const legacyExchangeABI = abis[SWAP_LEGACY_CONTRACT_ADDRESS]
const exchangeABI = abis[SWAP_CONTRACT_ADDRESS]
const swapLegacyABIInterface = new ethers.utils.Interface(legacyExchangeABI)
const swapABIInterface = new ethers.utils.Interface(exchangeABI)

const initPollExchangeFills = _.once(store => {
  const state = store.getState()
  const block = blockTrackerSelectors.getLatestBlock(state)
  fetchLogs(
    SWAP_LEGACY_CONTRACT_ADDRESS,
    legacyExchangeABI,
    swapLegacyABIInterface.events.Filled.topic,
    block.number - 7000, // 7000 is to include 24 hours worth of transactions, extra is included to cover variable block times (currently around 5000 transactions per day)
    block.number,
  ).then(logs => {
    store.dispatch(makeEventFetchingActionsCreators('exchangeFills').got(logs))
  })

  fetchLogs(
    SWAP_CONTRACT_ADDRESS,
    exchangeABI,
    swapABIInterface.events.Swap.topic,
    block.number - 7000, // 7000 is to include 24 hours worth of transactions, extra is included to cover variable block times (currently around 5000 transactions per day)
    block.number,
  ).then(logs => {
    store.dispatch(makeEventFetchingActionsCreators('swapFills').got(logs))
  })
})

const pollERC20Transfers = (store, block) => {
  const state = store.getState()
  const addresses = deltaBalancesSelectors.getTrackedWalletAddresses(state)
  if (!addresses.length) {
    return null
  }
  const { fromTopics, toTopics } = buildGlobalERC20TransfersTopics(addresses)

  Promise.all([
    fetchLogs(null, ERC20abi, fromTopics, block.number - 1, block.number), // might sometimes fetch balances twice, but better than missing an update
    fetchLogs(null, ERC20abi, toTopics, block.number - 1, block.number),
  ]).then(([fromLogs, toLogs]) => {
    const logs = [...fromLogs, ...toLogs]
    if (logs && logs.length) {
      store.dispatch(makeEventFetchingActionsCreators('erc20Transfers').got(logs))
    }
  })
}

function fetchMissingBlocksForFetchedEvents(store, action) {
  const fetchedBlockNumbers = blockTrackerSelectors.getBlockNumbers(store.getState())
  const eventBlockNumbers = _.get(action, 'response', []).map(({ blockNumber }) => blockNumber)
  const blockPromises = _.without(eventBlockNumbers, ...fetchedBlockNumbers).map(async blockNumber =>
    gethRead.fetchBlock(blockNumber),
  )

  Promise.all(blockPromises).then(blocks => {
    if (blocks.length) {
      store.dispatch(gotBlocks(blocks))
    }
  })
}

export default function eventsMiddleware(store) {
  return next => action => {
    switch (action.type) {
      case makeEventActionTypes('exchangeFills').got:
        fetchMissingBlocksForFetchedEvents(store, action)
        break
      case makeEventActionTypes('exchangeCancels').got:
        fetchMissingBlocksForFetchedEvents(store, action)
        break
      case makeEventActionTypes('exchangeFailures').got:
        fetchMissingBlocksForFetchedEvents(store, action)
        break
      case makeEventActionTypes('swapFills').got:
        fetchMissingBlocksForFetchedEvents(store, action)
        break
      case makeEventActionTypes('swapCancels').got:
        fetchMissingBlocksForFetchedEvents(store, action)
        break
      case 'GOT_LATEST_BLOCK':
        // check for new airswap fills on each new block
        fetchLogs(
          SWAP_LEGACY_CONTRACT_ADDRESS,
          legacyExchangeABI,
          swapLegacyABIInterface.events.Filled.topic,
          action.block.number - 1,
          action.block.number,
        ).then(logs => {
          const fillsTxIds = _.map(eventSelectors.getFetchedExchangeFills(store.getState()), 'transactionHash')
          const newFills = _.filter(logs, ({ transactionHash }) => !_.includes(fillsTxIds, transactionHash))
          if (logs && logs.length) {
            store.dispatch(makeEventFetchingActionsCreators('exchangeFills').got(newFills))
          }
        })

        fetchLogs(
          SWAP_LEGACY_CONTRACT_ADDRESS,
          legacyExchangeABI,
          swapLegacyABIInterface.events.Canceled.topic,
          action.block.number - 1,
          action.block.number,
        ).then(logs => {
          const cancelsTxIds = _.map(eventSelectors.getFetchedExchangeCancels(store.getState()), 'transactionHash')
          const newCancels = _.filter(logs, ({ transactionHash }) => !_.includes(cancelsTxIds, transactionHash))
          if (logs && logs.length) {
            store.dispatch(makeEventFetchingActionsCreators('exchangeCancels').got(newCancels))
          }
        })

        fetchLogs(
          SWAP_LEGACY_CONTRACT_ADDRESS,
          legacyExchangeABI,
          swapLegacyABIInterface.events.Failed.topic,
          action.block.number - 1,
          action.block.number,
        ).then(logs => {
          const failuresTxIds = _.map(eventSelectors.getFetchedExchangeFailures(store.getState()), 'transactionHash')
          const newFailures = _.filter(logs, ({ transactionHash }) => !_.includes(failuresTxIds, transactionHash))
          if (logs && logs.length) {
            store.dispatch(makeEventFetchingActionsCreators('exchangeFailures').got(newFailures))
          }
        })

        fetchLogs(
          SWAP_CONTRACT_ADDRESS,
          exchangeABI,
          swapABIInterface.events.Swap.topic,
          action.block.number - 1,
          action.block.number,
        ).then(logs => {
          const swapTxIds = _.map(eventSelectors.getFetchedSwapFills(store.getState()), 'transactionHash')
          const newSwapFills = _.filter(logs, ({ transactionHash }) => !_.includes(swapTxIds, transactionHash))
          if (logs && logs.length && newSwapFills.length) {
            const newFillsAction = makeEventFetchingActionsCreators('swapFills').got(newSwapFills)
            store.dispatch(newFillsAction)
          }
        })

        fetchLogs(
          SWAP_CONTRACT_ADDRESS,
          exchangeABI,
          swapABIInterface.events.Cancel.topic,
          action.block.number - 1,
          action.block.number,
        ).then(logs => {
          const swapTxIds = _.map(eventSelectors.getFetchedSwapCancels(store.getState()), 'transactionHash')
          const newSwapCancels = _.filter(logs, ({ transactionHash }) => !_.includes(swapTxIds, transactionHash))
          if (logs && logs.length && newSwapCancels.length) {
            store.dispatch(makeEventFetchingActionsCreators('swapCancels').got(newSwapCancels))
          }
        })

        // check for erc20 transfers on each new block
        pollERC20Transfers(store, action.block)
        break
      case 'FETCH_HISTORICAL_FILLS_BY_MAKER_ADDRESS':
        fetchFilledExchangeLogsForMakerAddress(action.makerAddress).then(logs => {
          const fillsTxIds = _.map(eventSelectors.getFetchedExchangeFills(store.getState()), 'transactionHash')
          const newFills = _.filter(logs, ({ transactionHash }) => !_.includes(fillsTxIds, transactionHash))
          if (logs && logs.length) {
            store.dispatch(makeEventFetchingActionsCreators('exchangeFills').got(newFills))
          }
        })
        break
      case 'FETCH_HISTORICAL_CANCELS_BY_MAKER_ADDRESS':
        fetchCanceledExchangeLogsForMakerAddress(action.makerAddress).then(logs => {
          const cancelsTxIds = _.map(eventSelectors.getFetchedExchangeCancels(store.getState()), 'transactionHash')
          const newCancels = _.filter(logs, ({ transactionHash }) => !_.includes(cancelsTxIds, transactionHash))
          if (logs && logs.length) {
            store.dispatch(makeEventFetchingActionsCreators('exchangeCancels').got(newCancels))
          }
        })
        break
      case 'FETCH_HISTORICAL_FAILURES_BY_MAKER_ADDRESS':
        fetchFailedExchangeLogsForMakerAddress(action.makerAddress).then(logs => {
          const failuresTxIds = _.map(eventSelectors.getFetchedExchangeFailures(store.getState()), 'transactionHash')
          const newFailures = _.filter(logs, ({ transactionHash }) => !_.includes(failuresTxIds, transactionHash))
          if (logs && logs.length) {
            store.dispatch(makeEventFetchingActionsCreators('exchangeFailures').got(newFailures))
          }
        })
        break
      case 'FETCH_HISTORICAL_SWAP_FILLS_BY_MAKER_ADDRESS':
        fetchSwapFillsForMakerAddress(action.makerAddress).then(logs => {
          const swapTxIds = _.map(eventSelectors.getFetchedSwapFills(store.getState()), 'transactionHash')
          const newSwapFills = _.filter(logs, ({ transactionHash }) => !_.includes(swapTxIds, transactionHash))
          if (logs && logs.length) {
            store.dispatch(makeEventFetchingActionsCreators('swapFills').got(newSwapFills))
          }
        })
        break
      case 'FETCH_HISTORICAL_SWAP_CANCELS_BY_MAKER_ADDRESS':
        fetchSwapCancelsForMakerAddress(action.makerAddress).then(logs => {
          const swapTxIds = _.map(eventSelectors.getFetchedSwapCancels(store.getState()), 'transactionHash')
          const newSwapCancels = _.filter(logs, ({ transactionHash }) => !_.includes(swapTxIds, transactionHash))
          if (logs && logs.length) {
            store.dispatch(makeEventFetchingActionsCreators('swapCancels').got(newSwapCancels))
          }
        })
        break
      default:
    }
    next(action)
    if (action.type === 'GOT_LATEST_BLOCK') {
      // needs to initialize after next(action) is called to have access to the latest state
      initPollExchangeFills(store) // only executes once since it is wrapped in _.once
    }
  }
}
