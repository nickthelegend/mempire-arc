// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Deploy} from "./Deploy.s.sol";

/// The game on a local **fork of Arc mainnet** run by Circle's Arc Foundry
/// (`arc-anvil --network arc`, which moves Arc's native USDC; plain anvil
/// can't). From the fork come Arc's real USDC (0x3600…0000), Chainlink's real
/// Data Feeds (every fighter's price), Chainlink's real CCIP router and
/// Circle's CCTP V2 TokenMessenger; our contracts are deployed with real signed
/// transactions — to the local fork only, never to mainnet.
///
///   arc-anvil --network arc --fork-url https://rpc.mainnet.arc.io --chain-id 31337 --port 8710
///   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8710 --broadcast
///
/// Keys derive from anvil's public test mnemonic at indices 7100+ (#7100
/// deploys and owns, #7101 is the relayer, #7102 stands in for the CRE
/// forwarder). Not the usual #0–#9: those are public
/// enough that Arc testnet carries 7702 sweepers on them and has blocklisted
/// some (#1 is refused by NativeCoinControl), and a fork inherits both. Never
/// use any of these anywhere real.
contract DeployLocal is Deploy {
    string internal constant MNEMONIC = "test test test test test test test test test test test junk";
    uint32 internal constant BASE = 7100;

    function run() external override {
        require(block.chainid != 5042 && block.chainid != 5042002, "DeployLocal is for a local fork only");
        Env memory e;
        e.pk = vm.deriveKey(MNEMONIC, BASE);
        e.deployer = vm.addr(e.pk);
        e.relayer = vm.addr(vm.deriveKey(MNEMONIC, BASE + 1));
        // Arc mainnet's CCIP router and CCTP V2 TokenMessenger, present on the fork.
        e.ccipRouter = vm.envOr("CCIP_ROUTER", 0xB79791184973589c38e114D43Eb8E4588C283A18);
        e.tokenMessenger = vm.envOr("TOKEN_MESSENGER", 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d);
        e.maxCashOut = 100e6;
        e.forwarder = vm.envOr("CRE_FORWARDER", vm.addr(vm.deriveKey(MNEMONIC, BASE + 2)));
        e.treasury = e.deployer;
        e.maxTier = 3;
        e.mintFee = 50_000;
        e.baseUri = vm.envOr("METADATA_BASE_URI", string("http://localhost:8799/nft/"));
        e.timeScale = uint32(vm.envOr("TIME_SCALE", uint256(60)));
        e.out = vm.envOr(
            "ADDRESSES_OUT",
            string.concat(vm.projectRoot(), "/../shared/deployments/", vm.toString(block.chainid), ".json")
        );
        _run(e);
    }
}
