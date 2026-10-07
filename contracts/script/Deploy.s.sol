// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MempireToken} from "../src/MempireToken.sol";
import {MempireCards} from "../src/MempireCards.sol";
import {MempireArena} from "../src/MempireArena.sol";
import {MarketMeta} from "../src/MarketMeta.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";

/// Deploys the whole game and registers the roster from shared/roster.json.
///
///   forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  owner + treasury for the testnet deployment
///   RELAYER               the address allowed to mint starter decks
///   PYTH                  Pyth contract (Monad testnet: 0x2880aB15…7B43)
///   AUSD                  Agora AUSD (Monad testnet: 0xa9012a05…22dC)
///   CRE_FORWARDER         KeystoneForwarder allowed to post market meta
///   METADATA_BASE_URI     where tokenURI points
///   TIME_SCALE            divides chest timers (60 on testnet)
contract Deploy is Script {
    using stdJson for string;

    uint256 internal constant REWARD_POOL = 1_000_000 ether;
    uint256 internal constant MINT_FEE = 0.01 ether;

    struct Env {
        uint256 pk;
        address deployer;
        address relayer;
        address pyth;
        address ausd;
        address forwarder;
        address ausdFaucet;
        string baseUri;
        uint32 timeScale;
    }

    struct Deployed {
        MempireToken token;
        MempireCards cards;
        MarketMeta meta;
        MempireArena arena;
    }

    function run() external virtual {
        _run(_env());
    }

    function _run(Env memory e) internal {
        (bytes32[] memory feeds, string[] memory tickers, uint32[] memory ages) = _roster();

        vm.startBroadcast(e.pk);
        Deployed memory d = _deploy(e);
        d.cards.registerCoins(feeds, tickers, ages);
        d.token.transfer(address(d.arena), REWARD_POOL);
        vm.stopBroadcast();

        console2.log("MempireToken ", address(d.token));
        console2.log("MempireCards ", address(d.cards));
        console2.log("MarketMeta   ", address(d.meta));
        console2.log("MempireArena ", address(d.arena));
        _write(e, d);
    }

    function _env() internal view returns (Env memory e) {
        e.pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        e.deployer = vm.addr(e.pk);
        e.relayer = vm.envAddress("RELAYER");
        e.pyth = vm.envAddress("PYTH");
        e.ausd = vm.envAddress("AUSD");
        e.forwarder = vm.envAddress("CRE_FORWARDER");
        // Agora's testnet faucet; the local stack deploys a mock with the same entry point.
        e.ausdFaucet = vm.envOr("AUSD_FAUCET", address(0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C));
        e.baseUri = vm.envString("METADATA_BASE_URI");
        e.timeScale = uint32(vm.envOr("TIME_SCALE", uint256(60)));
    }

    function _roster() internal view returns (bytes32[] memory feeds, string[] memory tickers, uint32[] memory ages) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../shared/roster.json"));
        uint256 n = abi.decode(vm.parseJson(json, ".coins[*].coinId"), (uint256[])).length;
        feeds = new bytes32[](n);
        tickers = new string[](n);
        ages = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".coins[", vm.toString(i), "]");
            require(json.readUint(string.concat(k, ".coinId")) == i, "roster out of order");
            feeds[i] = json.readBytes32(string.concat(k, ".feedId"));
            tickers[i] = json.readString(string.concat(k, ".ticker"));
            ages[i] = uint32(json.readUint(string.concat(k, ".maxPriceAge")));
        }
    }

    function _deploy(Env memory e) internal returns (Deployed memory d) {
        d.token = new MempireToken(e.deployer);
        d.cards = new MempireCards(e.deployer, d.token, IPyth(e.pyth), e.deployer, MINT_FEE, e.timeScale, e.baseUri);
        d.meta = new MarketMeta(e.deployer, e.forwarder);
        d.arena = new MempireArena(e.deployer, d.cards, e.ausd, d.meta, e.deployer);
        d.cards.setArena(address(d.arena));
        d.cards.setRelayer(e.relayer);
        d.meta.setPyth(IPyth(e.pyth), d.cards);
    }

    function _write(Env memory e, Deployed memory d) internal {
        string memory o = "deployment";
        o.serialize("chainId", block.chainid);
        o.serialize("deployer", e.deployer);
        o.serialize("relayer", e.relayer);
        o.serialize("pyth", e.pyth);
        o.serialize("ausd", e.ausd);
        o.serialize("creForwarder", e.forwarder);
        o.serialize("ausdFaucet", e.ausdFaucet);
        o.serialize("startBlock", block.number);
        o.serialize("token", address(d.token));
        o.serialize("cards", address(d.cards));
        o.serialize("marketMeta", address(d.meta));
        string memory out = o.serialize("arena", address(d.arena));
        vm.writeJson(out, string.concat(vm.projectRoot(), "/../shared/deployments/", vm.toString(block.chainid), ".json"));
    }
}
