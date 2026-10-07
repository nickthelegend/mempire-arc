// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MempireToken} from "../src/MempireToken.sol";
import {MempireCards} from "../src/MempireCards.sol";
import {MempireArena} from "../src/MempireArena.sol";
import {MarketMeta} from "../src/MarketMeta.sol";
import {SignedPriceOracle} from "../src/SignedPriceOracle.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";

/// Deploys the whole game to Arc and registers the roster from shared/roster.json.
/// One script for Arc testnet (5042002), Arc mainnet (5042) and a local Arc fork:
/// run it through `scripts/deploy.sh testnet|mainnet`, which sets the env below.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  broadcasts; owns the contracts until ADMIN accepts them
///   RELAYER               the relay's address: mints starter decks (never the owner)
///   ORACLE                "signed" (default: deploy a SignedPriceOracle for ORACLE_SIGNER)
///                         or "pyth" (use PYTH, Pyth's contract: Arc testnet only)
///   ORACLE_SIGNER         the relay's oracle-signing address (ORACLE=signed)
///   PYTH                  Pyth on Arc testnet: 0x2880aB155794e7179c9eE2e38200202908C17B43
///   CRE_FORWARDER         KeystoneForwarder for MarketMeta.onReport (Arc testnet only; 0 = none)
///   TREASURY              receives rake and mint fees (default: deployer)
///   ADMIN                 if set and not the deployer: ownership is offered to it (Ownable2Step)
///   MAX_TIER              highest stake tier open: 0 = $1 … 3 = $100 (default 3; mainnet 1)
///   MINT_FEE              USDC per mint, 6 decimals (default 50000 = $0.05; max $5)
///   METADATA_BASE_URI     where tokenURI points
///   TIME_SCALE            divides chest timers (60 on testnet, 1 on mainnet)
///   ADDRESSES_OUT         where to write the addresses (default shared/deployments/<chainId>.json)
contract Deploy is Script {
    using stdJson for string;

    /// Arc's USDC ERC-20 interface (6 decimals), the same address on testnet and mainnet.
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    uint256 internal constant REWARD_POOL = 1_000_000 ether;

    struct Env {
        uint256 pk;
        address deployer;
        address relayer;
        address oracle; // 0 = deploy a SignedPriceOracle
        string oracleKind;
        address oracleSigner;
        address forwarder;
        address treasury;
        address admin;
        uint8 maxTier;
        uint256 mintFee;
        string baseUri;
        uint32 timeScale;
        string out;
    }

    struct Deployed {
        MempireToken token;
        MempireCards cards;
        MarketMeta meta;
        MempireArena arena;
        address oracle;
    }

    function run() external virtual {
        _run(_env());
    }

    function _run(Env memory e) internal {
        require(USDC.code.length > 0, "no USDC at 0x3600...0000: not an Arc chain (or fork)");
        require(e.relayer != e.deployer, "RELAYER must not be the deployer/owner");
        (bytes32[] memory feeds, string[] memory tickers, uint32[] memory ages) = _roster();

        vm.startBroadcast(e.pk);
        Deployed memory d = _deploy(e);
        d.cards.registerCoins(feeds, tickers, ages);
        d.token.transfer(address(d.arena), REWARD_POOL);
        if (e.admin != address(0) && e.admin != e.deployer) {
            d.cards.transferOwnership(e.admin);
            d.meta.transferOwnership(e.admin);
            d.arena.transferOwnership(e.admin);
        }
        vm.stopBroadcast();

        console2.log("MempireToken      ", address(d.token));
        console2.log("MempireCards      ", address(d.cards));
        console2.log("MarketMeta        ", address(d.meta));
        console2.log("MempireArena      ", address(d.arena));
        console2.log("price oracle      ", d.oracle);
        _write(e, d);
    }

    function _env() internal view returns (Env memory e) {
        e.pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        e.deployer = vm.addr(e.pk);
        e.relayer = vm.envAddress("RELAYER");
        e.oracleKind = vm.envOr("ORACLE", string("signed"));
        if (keccak256(bytes(e.oracleKind)) == keccak256("pyth")) {
            e.oracle = vm.envAddress("PYTH");
            require(e.oracle.code.length > 0, "PYTH has no code on this chain (Pyth serves Arc testnet only)");
        } else {
            e.oracleKind = "signed";
            e.oracleSigner = vm.envAddress("ORACLE_SIGNER");
        }
        e.forwarder = vm.envOr("CRE_FORWARDER", address(0));
        e.treasury = vm.envOr("TREASURY", e.deployer);
        e.admin = vm.envOr("ADMIN", address(0));
        e.maxTier = uint8(vm.envOr("MAX_TIER", uint256(3)));
        e.mintFee = vm.envOr("MINT_FEE", uint256(50_000));
        e.baseUri = vm.envString("METADATA_BASE_URI");
        e.timeScale = uint32(vm.envOr("TIME_SCALE", uint256(60)));
        e.out = vm.envOr(
            "ADDRESSES_OUT",
            string.concat(vm.projectRoot(), "/../shared/deployments/", vm.toString(block.chainid), ".json")
        );
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
        d.oracle = e.oracle == address(0) ? address(new SignedPriceOracle(e.oracleSigner)) : e.oracle;
        d.token = new MempireToken(e.deployer);
        d.cards = new MempireCards(
            e.deployer, d.token, IERC20(USDC), IPyth(d.oracle), e.treasury, e.mintFee, e.timeScale, e.baseUri
        );
        d.meta = new MarketMeta(e.deployer, e.forwarder);
        d.arena = new MempireArena(e.deployer, d.cards, USDC, d.meta, e.treasury, e.maxTier);
        d.cards.setArena(address(d.arena));
        d.cards.setRelayer(e.relayer);
        d.meta.setOracle(IPyth(d.oracle), d.cards);
    }

    function _write(Env memory e, Deployed memory d) internal {
        if (keccak256(bytes(e.out)) == keccak256("none")) return;
        string memory o = "deployment";
        o.serialize("chainId", block.chainid);
        o.serialize("deployer", e.deployer);
        o.serialize("relayer", e.relayer);
        o.serialize("usdc", USDC);
        o.serialize("oracle", d.oracle);
        o.serialize("oracleKind", e.oracleKind);
        o.serialize("oracleSigner", e.oracleSigner);
        o.serialize("creForwarder", e.forwarder);
        o.serialize("treasury", e.treasury);
        o.serialize("admin", e.admin == address(0) ? e.deployer : e.admin);
        o.serialize("maxTier", uint256(e.maxTier));
        o.serialize("mintFee", e.mintFee);
        o.serialize("timeScale", uint256(e.timeScale));
        o.serialize("startBlock", block.number);
        o.serialize("token", address(d.token));
        o.serialize("cards", address(d.cards));
        o.serialize("marketMeta", address(d.meta));
        string memory out = o.serialize("arena", address(d.arena));
        vm.writeJson(out, e.out);
    }
}
