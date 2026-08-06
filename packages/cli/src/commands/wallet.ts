import { Args, Command } from "@oclif/core";
import { loadWalletPrivateKey, runEffect, saveWalletPrivateKey } from "@peardrop/core/node";
import * as Redacted from "effect/Redacted";
import { privateKeyToAccount } from "viem/accounts";

export default class WalletCommand extends Command {
  static override description = "Configure the local x402 relay payer wallet without printing its private key";

  static override args = {
    action: Args.string({ options: ["configure", "status"], default: "status", description: "configure saves PEARDROP_WALLET_PRIVATE_KEY with mode 0600" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(WalletCommand);
    const privateKey = await runEffect(loadWalletPrivateKey);
    if (args.action === "configure") {
      await runEffect(saveWalletPrivateKey(Redacted.value(privateKey)));
      this.log("PearDrop wallet saved at ~/.peardrop/wallet.json with mode 0600.");
      return;
    }
    this.log(`PearDrop x402 payer wallet: ${privateKeyToAccount(Redacted.value(privateKey)).address}`);
  }
}
