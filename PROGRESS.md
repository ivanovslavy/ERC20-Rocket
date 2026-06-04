# PROGRESS.md — Rocket Token (RCT)

Dnevnik na progresa i promenite. Nai-noviat zapis e otgore.

---

## 2026-06-04 — Auto-burn taksi, RPC fallback, fork test, README/LICENSE, GitHub

**Napraveno:**
- **Dogovor:** prodajbenite anti-bot taksi veche se **izgarjat avtomatichno** (burn kam address(0)), a ne otivat v portfeil. Premahnati `taxWallet` / `setTaxWallet`. Dobaveni `totalTaxBurned` i sabitie `AntiBotTaxBurned`.
- **RPC fallback** (`scripts/rpc.js`): ethers `FallbackProvider` nad Ankr klyuchovete ot `ANKR_API_KEYS` (red po prioritet, quorum 1) - ako edin RPC feilne, minava na sledvashtia. Per-veriga Ankr path-ove + chainId.
- `.env` sazdaden s realnite klyuchove (deployer PK, 5 Ankr klyucha, Etherscan/BscScan/PolygonScan). `.gitignore` izklyuchva `.env`, `node_modules/`, `deployed/`, `artifacts/`, `cache/`.
- `hardhat.config.js`: RPC URL-ite se vzemat ot Ankr (ili vanshen override), dobaveno mainnet `forking`. Etherscan API V2 (edin klyuch).
- `scripts/deploy.js`: za jivi mreji polzva fallback signer-a (`makeSigner`).
- **Fork test** (`test/Fork.ethereum.test.js`): forkva Ethereum mainnet s realen Uniswap V2. Pokriva: deploy -> add liquidity + setLp -> pokupka predi open (revert) -> executeTrading -> tier 1 max wallet -> sell taksi 50/40/30% (burn) -> sled blok 30 bez limit/taksa. **Vsichki 6 stapki minaha sreshtu realen fork.**
- `README.md` (EN, profesionalen) + `LICENSE` (MIT).
- Unit testovete aktualizirani za burn-logikata; vsichki 6 minavat.

**Rezultati ot fork testa (realen mainnet fork):**
- buyer1 kupi ~99.2M RCT (< 1%) - OK; golyama pokupka >1% revertna.
- Izgoreni taksi: blok 5 -> 50% (5M), blok 15 -> 40% (4M), blok 25 -> 30% (3M).
- Sled blok 30: pokupka > 1% mina (3.3B RCT), prodajba bez taksa/burn.

**Belejka po sigurnost:** sподелените v chata klyuchove (osobeno deployer PK) trjabva da se smjatat za potentsialno komprometirani - preporuchitelno e rotaciya predi mainnet upotreba s realni sredstva.

---

## 2026-06-04 — Inicialna nastroika na proekta

**Napraveno:**
- Sazdadena strukturata na Hardhat proekta v `~/Rocket-Token`.
- `contracts/RocketToken.sol` — ERC20 (Rocket/RCT), ERC20Burnable, Ownable, ReentrancyGuard (OZ v5):
  - Supply 100B, mintnat po deployera v konstruktora.
  - `setLp()` i `executeTrading()` — onlyOwner, samo vednuj.
  - `setTaxWallet()`, `setExempt()` — owner upravlenie.
  - `burnRocket()` — publichno burnvane (nonReentrant).
  - Guardian logika v `_update()`: max wallet pri buy (1%/2%/3% za blokove 1-10/11-20/21-30), sell taksa (50%/40%/30%), otpadat ot blok 31.
  - View helpers: `guardianBlock()`, `currentMaxWallet()`, `currentSellTaxBps()`.
- `hardhat.config.js` — Solidity 0.8.24, optimizer; mreji: localhost, sepolia, ethereum, base, bnb, polygon; Etherscan API V2 (edin string klyuch).
- `scripts/deploy.js` — deploy + zapis v `deployed/<network>_<data-chas>.json` + avtomatichna verifikacia (osven lokalno).
- `test/RocketToken.test.js` — testove za supply, once-only guardove, max wallet, sell taksa, burn.
- `.env.example`, `.gitignore`, `package.json`.
- `CLAUDE.md` — dokumentacia i pravila za rabota.

**Reshenia / belejki:**
- Tax destinaciata ne beshe ukazana — po podrazbiranie otiva v `taxWallet` (= owner pri deploy, smjana s `setTaxWallet`).
- Imenata na funkciite sa v camelCase (Solidity konvencia), no s tochno opisanata logika.
- Guardian buy/sell sa realizirani kato vatreshna logika v `_update()`, a ne kato otdelni vanshni funkcii — taka deistvat avtomatichno pri vseki DEX transfer.

**Sledvashti stapki (predlojenie):**
- `npm install` + `npx hardhat compile` + `npx hardhat test`.
- Da se reshi tochnata tax destinacia (treasury vs burn).
- Da se obmisli pò-niska maksimalna taksa za izbjagvane na "honeypot" flagove (vij mneniето v razgovora).
