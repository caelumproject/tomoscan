'use strict'

import Web3Util from './web3'
import { getSigner, toAddress } from './utils'
import EmailService from '../services/Email'

const db = require('../models')

let BlockHelper = {
    processBlock:async (blockNumber, startQueue) => {
        let block = db.Block.findOne({ number: blockNumber, nonce: { $exists: true } })
        let countTx = await db.Tx.find({ blockNumber: blockNumber }).count()
        if (block && countTx === block.e_tx) {
            console.log('Block already processed', blockNumber)
            return blockNumber
        }

        let web3 = await Web3Util.getWeb3()
        let _block = await web3.eth.getBlock(blockNumber, true)
        if (!_block) {
            return
        }

        // Get signer.
        let signer = toAddress(getSigner(_block), 100)
        signer = signer.toLowerCase()

        // Update end tx count.
        let endTxCount = await web3.eth.getBlockTransactionCount(_block.hash)
        _block.timestamp = _block.timestamp * 1000
        _block.e_tx = endTxCount
        _block.signer = signer

        let finalityNumber
        if (_block.finality) {
            finalityNumber = parseInt(_block.finality)
        } else {
            finalityNumber = 0
        }

        // blockNumber = 0 is genesis block
        if (parseInt(blockNumber) === 0) {
            finalityNumber = 100
        }

        _block.finality = finalityNumber
        let txs = _block.transactions
        delete _block['transactions']
        _block.status = true

        // Update address signer.
        await db.Account.findOneAndUpdate({ hash: signer }, { hash: signer })

        // Insert crawl for signer.
        const q = (startQueue) ? require('../queues') : false
        if (startQueue) {
            q.create('AccountProcess', { address: signer })
                .priority('low').removeOnComplete(true).save()
        }
        let signers
        if (_block.signers && _block.signers.length) {
            signers = _block.signers
        } else {
            signers = []
        }
        delete _block['_id']
        delete _block['signers']

        block = await db.Block.findOneAndUpdate({ number: _block.number }, _block,
            { upsert: true, new: true })

        await db.BlockSigner.findOneAndUpdate({ blockNumber: blockNumber },
            {
                blockNumber: blockNumber,
                finality: finalityNumber,
                signers: signers
            }, { upsert: true, new: true })

        // Sync txs.
        let txCount = db.Tx.find({ blockNumber: block.number }).count()
        if (txCount !== block.e_tx) {
            // Insert transaction before.
            for (let i = 0; i < txs.length; i++) {
                let tx = txs[i]

                if (tx.hash) {
                    if (block) {
                        tx.block = block
                    }
                    if (tx && tx.hash) {
                        if (tx.from !== null) {
                            let accountFrom = await db.Account.findOneAndUpdate(
                                { hash: tx.from.toLowerCase() },
                                { hash: tx.from.toLowerCase() },
                                { upsert: true, new: true }
                            )
                            tx.from = tx.from.toLowerCase()
                            tx.from_model = accountFrom
                            // Insert crawl for address.
                            if (startQueue) {
                                q.create('AccountProcess', { address: tx.from.toLowerCase() })
                                    .priority('low').removeOnComplete(true).save()
                            }
                        }
                        if (tx.to !== null) {
                            let accountTo = await db.Account.findOneAndUpdate(
                                { hash: tx.to.toLowerCase() },
                                { hash: tx.to.toLowerCase() },
                                { upsert: true, new: true }
                            )
                            tx.to = tx.to.toLowerCase()
                            tx.to_model = accountTo
                            // Insert crawl for address.
                            if (startQueue) {
                                q.create('AccountProcess', { address: tx.to })
                                    .priority('low').removeOnComplete(true).save()
                            }
                        }

                        delete tx['_id']

                        tx = await db.Tx.findOneAndUpdate({ hash: tx.hash }, tx,
                            { upsert: true, new: true })

                        // Insert crawl for tx.
                        if (startQueue) {
                            q.create('TransactionProcess', { hash: tx.hash.toLowerCase() })
                                .priority('critical').removeOnComplete(true).save()
                        }

                        // Send email to follower.
                        let cOr = (tx.to !== null)
                            ? [{ address: tx.from.toLowerCase() }, { address: tx.to.toLowerCase() }]
                            : [{ address: tx.from.toLowerCase() }]

                        let followers = await db.Follow.find({
                            startBlock: { $lte: tx.blockNumber },
                            sendEmail: true,
                            $or: cOr
                        })

                        if (followers.length) {
                            let email = new EmailService()
                            for (let i = 0; i < followers.length; i++) {
                                let follow = followers[i]
                                let user = await db.User.findOne({ _id: follow.user.toLowerCase() })
                                if (user) {
                                    if (follow.notifySent && follow.address === tx.from.toLowerCase()) {
                                        // isSent email template.
                                        email.followAlert(user, tx, follow.address, 'sent')
                                    } else if (follow.notifyReceive && follow.address === tx.to.toLowerCase()) {
                                        // isReceive email template.
                                        email.followAlert(user, tx, follow.address, 'received')
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return block
    }
}

export default BlockHelper
