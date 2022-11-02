import {
  EvmPriceServiceConnection,
  UnixTimestamp,
} from "@pythnetwork/pyth-evm-js";
import { addLeading0x, DurationInSeconds, sleep } from "./utils";
import { PriceInfo, PriceListener } from "./price-listener";
import { Contract } from "web3-eth-contract";
import AbstractPythAbi from "@pythnetwork/pyth-sdk-solidity/abis/AbstractPyth.json";
import Web3 from "web3";
import HDWalletProvider from "@truffle/hdwallet-provider";
import { PriceConfig } from "./price-config";
import { TransactionReceipt } from "ethereum-protocol";

export class Pusher {
  private connection: EvmPriceServiceConnection;
  private pythContract: Contract;
  private targetPriceListener: PriceListener;
  private sourcePriceListener: PriceListener;
  private priceConfigs: PriceConfig[];

  private cooldownDuration: DurationInSeconds;

  constructor(
    connection: EvmPriceServiceConnection,
    evmEndpoint: string,
    mnemonic: string,
    pythContractAddr: string,
    targetPriceListener: PriceListener,
    sourcePriceListener: PriceListener,
    priceConfigs: PriceConfig[],
    config: {
      cooldownDuration: DurationInSeconds;
    }
  ) {
    this.connection = connection;
    this.targetPriceListener = targetPriceListener;
    this.sourcePriceListener = sourcePriceListener;
    this.priceConfigs = priceConfigs;

    this.cooldownDuration = config.cooldownDuration;

    const provider = new HDWalletProvider({
      mnemonic: {
        phrase: mnemonic,
      },
      providerOrUrl: evmEndpoint,
    });

    const web3 = new Web3(provider as any);

    this.pythContract = new web3.eth.Contract(
      AbstractPythAbi as any,
      pythContractAddr,
      {
        from: provider.getAddress(0),
      }
    );
  }

  async start() {
    for (;;) {
      const pricesToPush: PriceConfig[] = [];
      const pubTimesToPush: UnixTimestamp[] = [];

      for (const priceConfig of this.priceConfigs) {
        const priceId = priceConfig.id;

        const targetLatestPrice =
          this.targetPriceListener.getLatestPriceInfo(priceId);
        const sourceLatestPrice =
          this.sourcePriceListener.getLatestPriceInfo(priceId);

        if (
          this.shouldUpdate(priceConfig, sourceLatestPrice, targetLatestPrice)
        ) {
          pricesToPush.push(priceConfig);
          pubTimesToPush.push((targetLatestPrice?.publishTime || 0) + 1);
        }
      }
      this.pushUpdates(pricesToPush, pubTimesToPush);
      await sleep(this.cooldownDuration * 1000);
    }
  }

  // The pubTimes are passed here to use the values that triggered the push.
  // This is an optimization to avoid getting a newer value (as an update comes)
  // and will help multiple price pushers to have consistent behaviour.
  async pushUpdates(
    pricesToPush: PriceConfig[],
    pubTimesToPush: UnixTimestamp[]
  ) {
    if (pricesToPush.length === 0) {
      return;
    }

    const priceIds = pricesToPush.map((priceConfig) =>
      addLeading0x(priceConfig.id)
    );

    const priceFeedUpdateData = await this.connection.getPriceFeedsUpdateData(
      priceIds
    );

    console.log(
      "Pushing ",
      pricesToPush.map(
        (priceConfig) => `${priceConfig.alias} (${priceConfig.id})`
      )
    );

    const updateFee = await this.pythContract.methods
      .getUpdateFee(priceFeedUpdateData.length)
      .call();
    console.log(`Update fee: ${updateFee}`);

    this.pythContract.methods
      .updatePriceFeedsIfNecessary(
        priceFeedUpdateData,
        priceIds,
        pubTimesToPush
      )
      .send({ value: updateFee })
      .on("transactionHash", (hash: string) => {
        console.log(`Successful. Tx hash: ${hash}`);
      })
      .on("error", (err: Error, receipt: TransactionReceipt) => {
        if (
          err.message.includes(
            "no prices in the submitted batch have fresh prices, so this update will have no effect"
          )
        ) {
          console.log(
            "The target chain price has already updated, Skipping this push."
          );
          return;
        }

        if (err.message.includes("the tx doesn't have the correct nonce.")) {
          console.log(
            "Multiple users are using the same accounts and nonce is incorrect. Skipping this push."
          );
          return;
        }

        if (
          err.message.includes("sender doesn't have enough funds to send tx.")
        ) {
          console.error("Payer is out of balance, please top it up.");
          throw err;
        }

        console.error("An unidentified error has occured:");
        console.error(err, receipt);
        console.error("Skipping this push.");
      });
  }

  /**
   * Checks whether on-chain price needs to be updated with the latest pyth price information.
   *
   * @param priceConfig Config of the price feed to check
   * @returns True if the on-chain price needs to be updated.
   */
  shouldUpdate(
    priceConfig: PriceConfig,
    sourceLatestPrice: PriceInfo | undefined,
    targetLatestPrice: PriceInfo | undefined
  ): boolean {
    const priceId = priceConfig.id;

    // There is no price to update the target with.
    if (sourceLatestPrice === undefined) {
      return false;
    }

    // It means that price never existed there. So we should push the latest price feed.
    if (targetLatestPrice === undefined) {
      console.log(
        `${priceConfig.alias} (${priceId}) is not available on the target network. Pushing the price.`
      );
      return true;
    }

    // The current price is not newer than the price onchain
    if (sourceLatestPrice.publishTime < targetLatestPrice.publishTime) {
      return false;
    }

    const timeDifference =
      sourceLatestPrice.publishTime - targetLatestPrice.publishTime;

    const priceDeviationPct =
      (Math.abs(
        Number(sourceLatestPrice.price) - Number(targetLatestPrice.price)
      ) /
        Number(targetLatestPrice.price)) *
      100;
    const confidenceRatioPct = Math.abs(
      (Number(sourceLatestPrice.conf) / Number(sourceLatestPrice.price)) * 100
    );

    console.log(`Analyzing price ${priceConfig.alias} (${priceId})`);

    console.log("Source latest price: ", sourceLatestPrice);
    console.log("Target latest price: ", targetLatestPrice);

    console.log(
      `Time difference: ${timeDifference} (< ${priceConfig.timeDifference}?)`
    );
    console.log(
      `Price deviation: ${priceDeviationPct.toFixed(5)}% (< ${
        priceConfig.priceDeviation
      }%?)`
    );
    console.log(
      `Confidence ratio: ${confidenceRatioPct.toFixed(5)}% (< ${
        priceConfig.confidenceRatio
      }%?)`
    );

    const result =
      timeDifference >= priceConfig.timeDifference ||
      priceDeviationPct >= priceConfig.priceDeviation ||
      confidenceRatioPct >= priceConfig.confidenceRatio;

    if (result == true) {
      console.log(
        "Some of the above values passed the threshold. Will push the price."
      );
    } else {
      console.log(
        "None of the above values passed the threshold. No push needed."
      );
    }

    return result;
  }
}
