import { EvmPriceServiceConnection, HexString } from "@pythnetwork/pyth-evm-js";
import { DurationInSeconds, PctNumber, sleep } from "./utils";
import { PriceListener } from "./price-listener";
import { Contract } from "web3-eth-contract";
import AbstractPythAbi from "@pythnetwork/pyth-sdk-solidity/abis/AbstractPyth.json";
import Web3 from "web3";
import HDWalletProvider from "@truffle/hdwallet-provider";

export class Pusher {
  private connection: EvmPriceServiceConnection;
  private pythContract: Contract;
  private targetPriceListener: PriceListener;
  private srcPriceListener: PriceListener;
  private priceIds: HexString[];

  private timeDifferenceThreshold: DurationInSeconds;
  private priceDeviationThreshold: PctNumber;
  private confidenceRatioThreshold: PctNumber;
  private cooldownDuration: DurationInSeconds;

  constructor(
    connection: EvmPriceServiceConnection,
    evmEndpoint: string,
    mnemonic: string,
    pythContractAddr: string,
    targetPriceListener: PriceListener,
    srcPriceListener: PriceListener,
    priceIds: HexString[],
    config: {
      timeDifferenceThreshold: DurationInSeconds;
      priceDeviationThreshold: PctNumber;
      confidenceRatioThreshold: PctNumber;
      cooldownDuration: DurationInSeconds;
    }
  ) {
    this.connection = connection;
    this.targetPriceListener = targetPriceListener;
    this.srcPriceListener = srcPriceListener;
    this.priceIds = priceIds;

    this.timeDifferenceThreshold = config.timeDifferenceThreshold;
    this.priceDeviationThreshold = config.priceDeviationThreshold;
    this.confidenceRatioThreshold = config.confidenceRatioThreshold;
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
    while (true) {
      const pricesToPush = this.priceIds.filter(this.shouldUpdate.bind(this));
      this.pushUpdates(pricesToPush);
      await sleep(this.cooldownDuration * 1000);
    }
  }

  async pushUpdates(pricesToPush: HexString[]) {
    if (pricesToPush.length === 0) {
      return;
    }

    const priceFeedUpdateData = await this.connection.getPriceFeedsUpdateData(
      pricesToPush
    );

    console.log("Pushing ", pricesToPush);

    this.pythContract.methods
      .updatePriceFeeds(priceFeedUpdateData)
      .send()
      .on("transactionHash", (hash: string) => {
        console.log(`Tx hash: ${hash}`);
      });
  }

  /**
   * Checks whether on-chain price needs to be updated with the latest pyth price information.
   *
   * @param priceId Id of the price feed to check
   * @returns True if the on-chain price needs to be updated.
   */
  shouldUpdate(priceId: HexString): boolean {
    const targetLatestPrice =
      this.targetPriceListener.getLatestPriceInfo(priceId);
    const srcLatestPrice = this.srcPriceListener.getLatestPriceInfo(priceId);

    // There is no price to update the target with.
    if (srcLatestPrice === undefined) {
      return false;
    }

    // It means that price never existed there. So we should push the latest price feed.
    if (targetLatestPrice === undefined) {
      console.log(
        `${priceId} is not available on the target network. Pushing the price.`
      );
      return true;
    }

    // The current price is not newer than the price onchain
    if (srcLatestPrice.publishTime < targetLatestPrice.publishTime) {
      return false;
    }

    const timeDifference =
      srcLatestPrice.publishTime - targetLatestPrice.publishTime;

    const priceDeviationPct =
      (Math.abs(
        Number(srcLatestPrice.price) - Number(targetLatestPrice.price)
      ) /
        Number(targetLatestPrice.price)) *
      100;
    const confidenceRatioPct = Math.abs(
      (Number(srcLatestPrice.conf) / Number(srcLatestPrice.price)) * 100
    );

    console.log(
      `Time difference: ${timeDifference} (< ${this.timeDifferenceThreshold}?)`
    );
    console.log(
      `Price deviation: ${priceDeviationPct.toFixed(5)}% (< ${
        this.priceDeviationThreshold
      }%?)`
    );
    console.log(
      `Confidence ratio: ${confidenceRatioPct.toFixed(5)}% (< ${
        this.confidenceRatioThreshold
      }%?)`
    );

    const result =
      timeDifference >= this.timeDifferenceThreshold ||
      priceDeviationPct >= this.priceDeviationThreshold ||
      confidenceRatioPct >= this.confidenceRatioThreshold;

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
