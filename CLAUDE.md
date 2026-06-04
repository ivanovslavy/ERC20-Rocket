# CLAUDE.md — Rocket Token (RCT)

Tozi fail e instrukcia za Claude Code (i za vseki razrabotchik) kak da raboti po tozi proekt.

## Proekt

Hardhat proekt za ERC20 token **Rocket (RCT)** s anti-bot "guardian" politiki za sigursten launch na DEX.

- **Token:** Rocket / RCT
- **Standart:** ERC20, ERC20Burnable, Ownable, ReentrancyGuard (OpenZeppelin v5)
- **Supply:** 100,000,000,000 RCT (100B), 18 desetichni, izcjalo mintnat po deployera pri deploy
- **Solidity:** 0.8.24, optimizer on (runs=200)
- **Glaven kontrakt:** `contracts/RocketToken.sol`

## Funkcionalnost / Anti-bot politiki

| Funkcia | Dostap | Opisanie |
|---|---|---|
| `setLp(address)` | onlyOwner, **samo vednuj** | Setva LP pair (DEX CA) adresa |
| `executeTrading()` | onlyOwner, **samo vednuj** | Otvarja treidinga, startira guardian taimera (iziskva setnato LP) |
| `setExempt(address,bool)` | onlyOwner | Osvobojdava adres ot restrikciite (router, treasury...) |
| `burnRocket(uint256)` | publichno, nonReentrant | Burnva sobstveni tokeni |

**Guardian logikata** se izpalniava avtomatichno v `_update()` (OZ v5 hook), broeno ot bloka na otvarjane (otvarjashtiat blok = blok 1):

- **BUY (from == lpPair)** — max balans na portfeil:
  - blok 1-10 → 1% ot supply
  - blok 11-20 → 2%
  - blok 21-30 → 3%
  - ot blok 31 → bez limit
- **SELL (to == lpPair)** — taksa, koiato se **IZGARJA avtomatichno** (namaljava total supply, nikoi ne ja sabira):
  - blok 1-10 → 50%
  - blok 11-20 → 40%
  - blok 21-30 → 30%
  - ot blok 31 → 0%

`totalTaxBurned` pazi obshtoto kolichestvo izgoreni ot taksi RCT.

Exempt adresite (owner, kontraktat i vsichko dobaveno s `setExempt`) zaobikaljat vsichki restrikcii. Predi `executeTrading()` samo exempt adresi mogat da prashtat tokeni.

## Komandi

```bash
npm install                       # instalira zavisimostite
npx hardhat compile               # kompilira
npx hardhat test                  # testove
npx hardhat node                  # lokalna veriga
npm run deploy:localhost          # deploy lokalno
npm run deploy:sepolia            # deploy + verify na Sepolia
npm run deploy:ethereum           # ... ethereum / base / bnb / polygon
```

Deploy info se zapisva avtomatichno v `deployed/<network>_<data-chas>.json`.

## Konfiguracia

- Kopirai `.env.example` -> `.env` i popalni `PRIVATE_KEY`, RPC URL-ite i `ETHERSCAN_API_KEY`.
- **Etherscan API V2:** edin edinstven API klyuch raboti za vsichki verigi (Ethereum, Sepolia, Base, Polygon, BNB). Zatova v `hardhat.config.js` `etherscan.apiKey` e **string**, a ne obekt.

## Pravila za rabota (VAJNO)

1. **Vinagi aktualizirai `PROGRESS.md`** sled vsjaka promjana — nov zapis s data, kakvo e napraveno i zashto.
2. **Nikoga ne commitvai `.env`** ili realni privatni klyuchove. Samo `.env.example`.
3. Sled promjana po `contracts/` — vinagi `npx hardhat compile` i `npx hardhat test` predi da se smjata za gotovo.
4. Pazi `setLp` / `executeTrading` da ostanat "samo vednuj" — ne premahvai guard flagovete.
5. Pri promjana na anti-bot parametri (procenti/taksi/blokove) opisvai gi i v `CLAUDE.md`, i v `PROGRESS.md`.
6. Ne triy fajlove ot `deployed/` — tova e istoriata na deploymentite.
7. Imenata na verigite v config-a (`ethereum`, `bnb`...) trjabva da savpadat s tezi v `package.json` skriptovete.
8. Predi mainnet deploy — testvai na `localhost` i `sepolia`.
