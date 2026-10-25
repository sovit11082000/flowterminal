# Order-flow data ko kaise padhein

Ye guide chart ko samajhne aur apna process banane ke liye hai. Koi indicator ya checklist trade ko pakka nahi banata. Pehle replay/paper par observe karo; real trade ka faisla, size aur risk tumhari zimmedari hai.

## Pehle data sahi hai ya nahi check karo

Trade dekhne se pehle ye checks karo:

- **Market aur contract:** symbol, exchange, spot/perpetual aur timeframe sahi ho. BTCUSDT perpetual ka price kisi doosre exchange ke spot BTC se bilkul same hona zaroori nahi.
- **Live feed:** latest candle ka waqt abhi ke paas ho; `Latest candle` ruk gaya ho ya status disconnected/stale ho to order-flow signal par bharosa mat karo.
- **Price match:** chart close ko Bybit last/mark price se milao. Thoda farq normal hai (last trade aur mark alag hote hain); bada ya lagataar farq feed, symbol ya timestamp issue ho sakta hai.
- **Volume aur footprint:** live trades aane ke baad hi footprint/delta banta hai. Purani OHLC candles se asli bid/ask footprint, CVD, iceberg ya liquidation history dobara nahi ban sakti. Recorder chalne se pehle ka order-book heatmap bhi available nahi hota.
- **Time zone:** candles ka stored time UTC hota hai; display India time mein ho sakta hai. Exchange ke timestamp ke saath ek hi event compare karo.
- **Thin data:** khali candle, kam trade count, missing footprint, ya orderbook desync ke waqt signal ko “unknown” samjho, zero activity nahi.

## Har panel ka matlab

### Candles aur volume

Candles price ka open, high, low, close batati hain. Volume batata hai kitna trade hua, lekin candle akeli nahi batati kis side ne market order maara. Pehle swing highs/lows aur important levels mark karo; phir order-flow ko context ke liye dekho.

### Footprint

Har price row par **Bid** wo volume hai jahan sellers ne bid hit ki; **Ask** wo volume hai jahan buyers ne ask lift ki. Row delta = Ask − Bid. Candle delta = us candle ke buy volume − sell volume.

- Ek bada imbalance akela entry signal nahi. Dekho kya paas ke kai price rows par imbalance hai aur price us direction mein progress kar raha hai.
- **Absorption ka mumkin sanket:** ek level par baar-baar aggressive volume aaye, par price aage na badhe. Isse reversal confirm nahi hota; level toot bhi sakta hai.
- **POC** us bar ka sabse zyada traded price level hai. Ye us bar ki activity ka center hai, support/resistance ki guarantee nahi.
- Cluster aggregation tick size par depend karti hai. Tick metadata galat ya missing ho to rows aur imbalance galat group ho sakte hain.

### Delta aur CVD

Delta har bar ka aggressive buying minus aggressive selling hai. CVD in deltas ka running sum hai. Price upar ja raha ho aur CVD us move ko support na kare to divergence ka *sawal* uthta hai; ye apne aap short signal nahi.

Feed reconnect, late trades aur CVD reset ki wajah se CVD ka start point badal sakta hai. Alag sessions/process restarts ke CVD ko seedha compare mat karo jab tak accumulation boundary maloom na ho.

### Volume Profile

Profile selected period/range mein har price par volume dikhata hai. **POC** sabse zyada volume wala price; **VAH/VAL** chosen value-area percentage ke andar ka upper/lower boundary. HVN aksar acceptance/rotation dikhata hai, LVN kam trade hua area. Session/visible-range badalne se levels badlenge. Profile ki range aur source data dekhkar hi level ka matlab nikalo.

### DOM, tape aur heatmap

DOM abhi ka displayed limit orderbook hai; tape executed trades dikhati hai. DOM size cancel ya move ho sakti hai—wall ko committed support/resistance mat samjho. Heatmap sirf recorder chalne ke baad ke sampled snapshots dikhati hai; 500 ms ke beech ke chhote events chhoot sakte hain. Spoofing ya iceberg ko public data se confirm nahi kiya ja sakta; app ke labels heuristic hain.

### Open Interest aur funding

**Open Interest (OI)** khule derivative contracts ka total hai, direction nahi. Price aur OI saath badhna naye contracts khulne ke saath consistent hai; price badhe/OI ghate to short covering ho sakti hai. Dono interpretations hain, proof nahi. Funding perpetual longs aur shorts ke beech periodic payment rate hai; positive/negative funding crowding ka clue ho sakti hai, reversal timer nahi. OI series ka unit, update interval aur exchange/symbol verify karo.

### Liquidations

Bubble ek reported forced close ko dikhati hai, market ka poora stop map nahi. Exchange feed incomplete/limited ho sakti hai. Bubble ko level touch hone ki prediction mat samjho.

## Trade se pehle observation checklist

Har item ko **haan / nahi / maloom nahi** mark karo. “Maloom nahi” ka matlab hai ki data se abhi nateeja nahi nikal sakte.

1. Kya live status aur latest candle waqt current hain?
2. Kya symbol, contract type, timeframe aur price source verify kiye?
3. Kya chart par pehle se ek meaningful level/area hai, aur uska timeframe/context likha hai?
4. Kya price us area par reaction dikha raha hai—sirf wahan pahunchna nahi?
5. Kya tape/footprint aggressive side aur price progress ek doosre ko support karte hain, ya absorption/divergence ka sirf possible clue hai?
6. Kya volume/profile/DOM ka data us range ke liye maujood aur synchronized hai?
7. Kya entry ka reason, invalidation level (jahan idea galat maana jayega), stop distance aur pehle se tay risk likha hai?
8. Kya spread, fees, slippage aur event/news risk ko dhyan mein rakha hai?
9. Kya trade miss ho jaaye to chase nahi karoge, aur stop ko loss se bachne ke liye door nahi karoge?

“Confirm trade” ka matlab 9/9 score nahi. Ek setup ko pehle define karo, screenshots/notes ke saath replay ya paper trade mein sample jama karo, phir dekho ki rules alag market conditions mein kaise chale. Is project ke footprint, heatmap aur liquidations ki history local recorder start hone ke baad hi jama hoti hai; naya recorder turant pichla mahina nahi bhar sakta.

## Practice journal template

- Date/time (IST) / symbol / contract / timeframe:
- Market context aur marked level:
- Setup ka naam aur entry se pehle likha reason:
- Footprint/delta/CVD observation (data gap bhi likho):
- Volume profile level aur selected range:
- DOM/tape/heatmap/OI/funding jo actually available tha:
- Invalidation, planned risk, stop aur target:
- Outcome ke baad: rule follow kiya? Kya seekha?

Pehle 20–30 examples paper/replay mein isi ek setup ke liye likho. Ye koi statistically guaranteed sample size nahi; maqsad hai ki tumhe apne rules aur data ki kami samajh aaye, aur bina record ke “signal kaam karta hai” na maan lo.
