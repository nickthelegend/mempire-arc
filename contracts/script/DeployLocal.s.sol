// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Deploy} from "./Deploy.s.sol";
import {LocalPriceOracle} from "../src/LocalPriceOracle.sol";

/// The game on a local anvil **fork of Monad testnet**: the real Agora AUSD and
/// its real `requestFunds` faucet come from the fork, our four contracts are
/// deployed with real signed transactions, and prices come from a
/// LocalPriceOracle that only accepts updates signed by the relay's oracle key
/// (Pyth's model; Hermes needs a key and does not serve a local chain).
///
///   anvil --fork-url https://testnet-rpc.monad.xyz --chain-id 31337 --port 8612 --prune-history 300
///   forge script script/DeployLocal.s.sol --rpc-url fork --broadcast
///
/// Keys are anvil's well-known dev accounts, derived from its public test
/// mnemonic: #0 deploys and owns, #1 is the relayer, #2 stands in for the CRE
/// forwarder, #4 signs oracle prices. Never use these anywhere real.
contract DeployLocal is Deploy {
    string internal constant MNEMONIC = "test test test test test test test test test test test junk";
    /// Agora's AUSD and testnet faucet — present on the fork.
    address internal constant AUSD = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
    address internal constant AUSD_FAUCET = 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C;

    function run() external override {
        uint256 pk = vm.deriveKey(MNEMONIC, 0);
        address oracleSigner = vm.envOr("ORACLE_SIGNER", vm.addr(vm.deriveKey(MNEMONIC, 4)));
        require(AUSD.code.length > 0, "AUSD missing: run against a fork of Monad testnet");

        vm.startBroadcast(pk);
        LocalPriceOracle oracle = new LocalPriceOracle(oracleSigner);
        vm.stopBroadcast();

        Env memory e;
        e.pk = pk;
        e.deployer = vm.addr(pk);
        e.relayer = vm.addr(vm.deriveKey(MNEMONIC, 1));
        e.pyth = address(oracle);
        e.ausd = AUSD;
        e.ausdFaucet = AUSD_FAUCET;
        e.forwarder = vm.envOr("CRE_FORWARDER", vm.addr(vm.deriveKey(MNEMONIC, 2)));
        e.baseUri = vm.envOr("METADATA_BASE_URI", string("http://localhost:8799/nft/"));
        e.timeScale = uint32(vm.envOr("TIME_SCALE", uint256(60)));
        _run(e);
    }
}
