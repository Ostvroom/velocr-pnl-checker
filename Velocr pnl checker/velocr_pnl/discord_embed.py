"""Optional: Discord embed formatting (install with `pip install velocr-pnl[discord]`)."""

from datetime import datetime
from typing import Any, Dict

from discord import Color, Embed


def format_pnl_embed(data: Dict[str, Any]) -> Embed:
    if "error" in data:
        return Embed(title="❌ PNL Error", description=str(data["error"]), color=Color.red())

    if data.get("mode") == "moralis_trades":
        sym = data["symbol"]
        net = float(data.get("net_trades") or 0)
        report_color = 5814783
        total_trades = int(data.get("trades_rows") or 0)
        mint_n = int(data.get("mint_count") or 0)
        mint_sp = float(data.get("mint_spend") or 0)
        buy_vol = float(data.get("est_buy_volume") or 0)
        sell_vol = float(data.get("est_sell_volume") or 0)
        pnl_pct = data.get("pnl_percent")
        pct_str = f"{pnl_pct:.1f}%" if isinstance(pnl_pct, (int, float)) else "N/A"
        best_t = data.get("best_trade")
        worst_t = data.get("worst_trade")
        best_str = f"`{best_t:.4f} {sym}`" if isinstance(best_t, (int, float)) and best_t > 0 else "—"
        worst_str = f"`{worst_t:.4f} {sym}`" if isinstance(worst_t, (int, float)) and worst_t > 0 else "—"
        timeframe = data.get("moralis_period_note") or "—"
        if data.get("hit_row_cap") or data.get("hit_transfer_cap"):
            timeframe += "\n_Page cap — raise `PNL_MORALIS_MAX_PAGES` for more rows._"

        embed = Embed(
            title="📊 NFT Trading PnL Report",
            color=report_color,
            timestamp=datetime.utcnow(),
        )
        embed.add_field(
            name="👤 Wallet",
            value=f"`{data['wallet']}`",
            inline=False,
        )
        embed.add_field(
            name="🔢 Marketplace trades",
            value=f"`{total_trades:,}`",
            inline=True,
        )
        embed.add_field(
            name="🪙 Mints",
            value=f"`{mint_n:,}`\n_From `0x…0` → you_",
            inline=True,
        )
        embed.add_field(
            name="💰 Secondary buy",
            value=f"`{buy_vol:.4f} {sym}`",
            inline=True,
        )
        embed.add_field(name="💸 Total sell", value=f"`{sell_vol:.4f} {sym}`", inline=True)
        embed.add_field(
            name="⛏️ Est. mint spend",
            value=f"`{mint_sp:.4f} {sym}`\n_Sum of `value` on mint logs_",
            inline=True,
        )
        embed.add_field(
            name="📈 Net PnL",
            value=f"`{net:.4f} {sym}` **({pct_str})**\n_Sell − secondary buy − mint spend_",
            inline=True,
        )
        embed.add_field(
            name="🏆 Best Trade",
            value=f"{best_str}\n_Single largest sale_",
            inline=True,
        )
        embed.add_field(
            name="📉 Worst Trade",
            value=f"{worst_str}\n_Single largest buy_",
            inline=True,
        )
        embed.add_field(
            name="⏱️ Timeframe",
            value=timeframe[:1024] if timeframe else "—",
            inline=False,
        )

        return embed

    return Embed(
        title="❌ PNL Error",
        description="Unknown PNL response.",
        color=Color.red(),
    )
