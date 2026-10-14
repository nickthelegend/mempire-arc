# Live Arc mainnet deployment

Chain 5042; production receipts checked on 2026-10-14. Testnet records are retained separately.

| Contract | Mainnet address |
|---|---|
| arena | [0x3F1b2Fb46C95e1B406338e28bDe54f585536A4Ec](https://explorer.arc.io/address/0x3F1b2Fb46C95e1B406338e28bDe54f585536A4Ec) |
| cards | [0xE28f4571e0fb238106b52AbAa1C579ff6642FA63](https://explorer.arc.io/address/0xE28f4571e0fb238106b52AbAa1C579ff6642FA63) |
| ccipGateway | [0x54A42df299044B79d5FefF43b74a70517c801985](https://explorer.arc.io/address/0x54A42df299044B79d5FefF43b74a70517c801985) |
| ccipRouter | [0xB79791184973589c38e114D43Eb8E4588C283A18](https://explorer.arc.io/address/0xB79791184973589c38e114D43Eb8E4588C283A18) |
| creForwarder | [0x0000000000000000000000000000000000000000](https://explorer.arc.io/address/0x0000000000000000000000000000000000000000) |
| marketMeta | [0xC9910d40a9cA037dbEcab6ba2e3c7c146020B79C](https://explorer.arc.io/address/0xC9910d40a9cA037dbEcab6ba2e3c7c146020B79C) |
| token | [0x48F55b579E078dF3f6d6A7015DD957C688a43468](https://explorer.arc.io/address/0x48F55b579E078dF3f6d6A7015DD957C688a43468) |
| tokenMessenger | [0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d](https://explorer.arc.io/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |

## Transactions

- CREATE MempireToken : [0xe7c3c296520ec5023813f90bd8ca4bb929e3789c718842925d10f6d532551a11](https://explorer.arc.io/tx/0xe7c3c296520ec5023813f90bd8ca4bb929e3789c718842925d10f6d532551a11); status 1; gas 0.0170545210 USDC.
- CREATE MempireCards : [0x589fd6f329df73383bb4f64ce484e2adb219447bbdecb7574efbc2d86734e627](https://explorer.arc.io/tx/0x589fd6f329df73383bb4f64ce484e2adb219447bbdecb7574efbc2d86734e627); status 1; gas 0.0908075252 USDC.
- CREATE MarketMeta : [0x89c9626f28a40c32930ea57b80ff5ea8fdc4d53a752f77d25c4a656d811242ea](https://explorer.arc.io/tx/0x89c9626f28a40c32930ea57b80ff5ea8fdc4d53a752f77d25c4a656d811242ea); status 1; gas 0.0254038215 USDC.
- CREATE MempireArena : [0x47298e5e64faf57e8f55bd2e841b80ed99daf842a3383cb65ac510447ba55572](https://explorer.arc.io/tx/0x47298e5e64faf57e8f55bd2e841b80ed99daf842a3383cb65ac510447ba55572); status 1; gas 0.0617005036 USDC.
- CALL MempireCards setArena(address): [0x3c09ec972e4e5e0133003fa9b3abca6fcece3881a965e0b839524ebb8c52ef97](https://explorer.arc.io/tx/0x3c09ec972e4e5e0133003fa9b3abca6fcece3881a965e0b839524ebb8c52ef97); status 1; gas 0.0009392201 USDC.
- CALL MempireCards setRelayer(address): [0xb9a18875bd1b4c2618d7c77fc6904670d403b0736d7c605cf3ca1ad68376a6d1](https://explorer.arc.io/tx/0xb9a18875bd1b4c2618d7c77fc6904670d403b0736d7c605cf3ca1ad68376a6d1); status 1; gas 0.0009462601 USDC.
- CALL MarketMeta setCards(address): [0xdf422ccf844c1750f8fca71b63a2a220090b1e672e933ab2f4b92fa39df7c057](https://explorer.arc.io/tx/0xdf422ccf844c1750f8fca71b63a2a220090b1e672e933ab2f4b92fa39df7c057); status 1; gas 0.0009486401 USDC.
- CREATE MempireCCIPGateway : [0xaece796df38c51ad6b0daffa5a9ade855fe615fe49511c7bbf4b5ad5269a475a](https://explorer.arc.io/tx/0xaece796df38c51ad6b0daffa5a9ade855fe615fe49511c7bbf4b5ad5269a475a); status 1; gas 0.0297254817 USDC.
- CALL MempireArena setEntryGateway(address): [0x0690f9c101a951cc3c8810fea11d740b7ec8c10590dc944e7031828c5e99c0f9](https://explorer.arc.io/tx/0x0690f9c101a951cc3c8810fea11d740b7ec8c10590dc944e7031828c5e99c0f9); status 1; gas 0.0006016800 USDC.
- CALL MempireCards registerCoins(bytes32[],string[],uint32[],address[]): [0xe59efb328a2457f111b29f812dfe140bcc9e8ab1ced78d8f31fe28fefdd10a25](https://explorer.arc.io/tx/0xe59efb328a2457f111b29f812dfe140bcc9e8ab1ced78d8f31fe28fefdd10a25); status 1; gas 0.0480542628 USDC.
- CALL MempireToken transfer(address,uint256): [0x6161991f6d2ab19926d0a7ccbd0594df58ea9a3f7abd4b7d249f0fee5ff280e0](https://explorer.arc.io/tx/0x6161991f6d2ab19926d0a7ccbd0594df58ea9a3f7abd4b7d249f0fee5ff280e0); status 1; gas 0.0010263601 USDC.
- CALL MempireCards transferOwnership(address): [0x4d54be215a819004891dd1454c402143c4d46faac5761f76c658e5df112b0f31](https://explorer.arc.io/tx/0x4d54be215a819004891dd1454c402143c4d46faac5761f76c658e5df112b0f31); status 1; gas 0.0009813801 USDC.
- CALL MarketMeta transferOwnership(address): [0x6053f8354a1176dd9d95c1ee8ac031391e0c28cc744e11ee43bad05cc9245e09](https://explorer.arc.io/tx/0x6053f8354a1176dd9d95c1ee8ac031391e0c28cc744e11ee43bad05cc9245e09); status 1; gas 0.0009610601 USDC.
- CALL MempireArena transferOwnership(address): [0x9fd3945cc3e0336daadef9644c7603f4fd827b42eefca2d85aa8f757ba5e267b](https://explorer.arc.io/tx/0x9fd3945cc3e0336daadef9644c7603f4fd827b42eefca2d85aa8f757ba5e267b); status 1; gas 0.0009748801 USDC.
- CALL MempireCCIPGateway transferOwnership(address): [0xdb7ecf3675c27f34317c492aa3a1badfaa40dd3e58a50cb98e2f32c5f736a084](https://explorer.arc.io/tx/0xdb7ecf3675c27f34317c492aa3a1badfaa40dd3e58a50cb98e2f32c5f736a084); status 1; gas 0.0009594001 USDC.
- Safe accepts cards ownership: [0xa6e869847a548afdb3fafc02bd2dee98930d3647f947524642268b85465937b0](https://explorer.arc.io/tx/0xa6e869847a548afdb3fafc02bd2dee98930d3647f947524642268b85465937b0); status 1; gas 0.0014071050 USDC.
- Safe accepts marketMeta ownership: [0x207974f6558b113cdb3cc24656048b56080bbe599980a4b29e881aa57258030c](https://explorer.arc.io/tx/0x207974f6558b113cdb3cc24656048b56080bbe599980a4b29e881aa57258030c); status 1; gas 0.0013978020 USDC.
- Safe accepts arena ownership: [0x67be9fa35803ac442a3f5d195d9c605260590c1a05e25d38467f261f84e1d717](https://explorer.arc.io/tx/0x67be9fa35803ac442a3f5d195d9c605260590c1a05e25d38467f261f84e1d717); status 1; gas 0.0014068740 USDC.
- Safe accepts ccipGateway ownership: [0x622783c2e8dfd2e3d46865c3b38b7c96a173cc0a49e600f944e6138538413bfa](https://explorer.arc.io/tx/0x622783c2e8dfd2e3d46865c3b38b7c96a173cc0a49e600f944e6138538413bfa); status 1; gas 0.0013971930 USDC.
- service float RELAYER .9: [0x31933d4b9c02e42dd5041448aa8ece689cafb123918ad31ceaa0a19008d97562](https://explorer.arc.io/tx/0x31933d4b9c02e42dd5041448aa8ece689cafb123918ad31ceaa0a19008d97562); status 1; gas 0.0004410000 USDC.
- service float AGENT_OWNER_ADDRESS .1: [0x81bfbe3f140796342cd9572debbccfe107dab307894581e5b1c6ef0445853502](https://explorer.arc.io/tx/0x81bfbe3f140796342cd9572debbccfe107dab307894581e5b1c6ef0445853502); status 1; gas 0.0004410000 USDC.
- Register ERC-8004 AI opponent identity: [0x2457c333309438ee57f9a29b09ed80c22f0656bfd19ae54885c8ad6fd8f16fc2](https://explorer.arc.io/tx/0x2457c333309438ee57f9a29b09ed80c22f0656bfd19ae54885c8ad6fd8f16fc2); status 1; gas 0.0042169680 USDC.
- Smoke: mint eight starter cards with live roster: [0xed4afeb9369cb61b24b4448f53e5ef77d71c947bdd594ec37d3964cfd6fe3da9](https://explorer.arc.io/tx/0xed4afeb9369cb61b24b4448f53e5ef77d71c947bdd594ec37d3964cfd6fe3da9); status 1; gas 0.0223894230 USDC.

Total recorded project gas: 0.3141823612 USDC.

Mainnet smoke is script-driven; hosted mainnet browser transactions and cross-chain delivery are Not run. Public testnet proof remains separately labelled. Production role keys are outside this repository.

All 20 mainnet Chainlink prices passed freshness/positivity checks. Safe accepted all four owners; ERC-8004 opponent #2434 is registered. Starter-deck mint is Live; a paid game/PvP, hosted mainnet metadata and agent HTTP transport are Not run. Metadata origin is https://mempire-arc-nicolas-projects-f497bb7f.vercel.app. Source verification was attempted; explorer API returned a Cloudflare challenge.
