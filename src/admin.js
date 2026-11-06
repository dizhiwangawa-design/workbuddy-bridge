const VERSION = '0.4.0';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * 号池管理面板。
 *
 * 单文件、零外部依赖（不引 CDN），断网也能打开；数据走 /api/pool 与 /api/stats。
 * 客户端只做渲染，区间聚合与调度规则都在服务端，避免两边口径漂移。
 */
export function adminPage({ home = '', token = '' } = {}) {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<link rel="icon" href="data:,"/>
<title>WorkBuddy 数据看板</title>
<style>
  :root{
    color-scheme:light dark;
    --bg:#f5f5f9; --card:#fff; --fg:#17171e; --sub:#666777; --muted:#9b9cab;
    --line:#ededf4; --line2:#e2e2ec; --soft:#f7f6fc;
    --brand:#8b7cf6; --brand2:#b9a9ff; --brand-deep:#7357e8;
    --ok:#18a558; --bad:#e5484d; --warn:#e9a23b; --idle:#a3a3b2;
    --h0:#f1eefb; --h1:#ded5fb; --h2:#c3b2f8; --h3:#a184f6; --h4:#7c5cf0;
    --radius:14px;
    --shadow:0 1px 2px rgba(20,20,40,.04), 0 10px 28px -20px rgba(20,20,40,.35);
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#0d0d12; --card:#15151d; --fg:#f2f2f7; --sub:#a2a2b2; --muted:#70707f;
      --line:#25252f; --line2:#31313d; --soft:#1a1a24;
      --brand:#9a86ff; --brand2:#7b64d8; --brand-deep:#b3a2ff;
      --ok:#34c47c; --bad:#ff6b70; --warn:#f0b45c; --idle:#6b6b7a;
      --h0:#1c1c26; --h1:#2c2549; --h2:#41366f; --h3:#63509f; --h4:#8f77e8;
      --shadow:0 1px 2px rgba(0,0,0,.5), 0 14px 36px -22px rgba(0,0,0,.9);
    }
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--bg);color:var(--fg);
       font:13.5px/1.55 ui-sans-serif,-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
       -webkit-font-smoothing:antialiased}
  .wrap{max-width:1320px;margin:0 auto;padding:22px 22px 56px}
  button,select,input{font:inherit;color:inherit}
  b,strong{font-weight:600}

  /* ------------------------------------------------------------ 头部 */
  header{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:16px}
  .brand{display:flex;align-items:center;gap:10px;min-width:0}
  .logo{width:32px;height:32px;border-radius:9px;background:linear-gradient(140deg,#8b7cf6,#b9a9ff);
        color:#fff;display:grid;place-items:center;font-weight:700;font-size:15px;flex:none;
        box-shadow:0 6px 14px -8px rgba(124,92,255,.9)}
  h1{font-size:19px;margin:0;letter-spacing:-.015em;font-weight:650}
  .sub{color:var(--sub);font-size:12px;margin-top:1px}
  .sub b{color:var(--fg);font-weight:600;font-variant-numeric:tabular-nums}
  .grow{flex:1}
  .head-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

  .seg{display:flex;align-items:center;gap:2px;background:var(--card);border:1px solid var(--line);
       border-radius:11px;padding:3px;box-shadow:var(--shadow)}
  .seg button{border:0;background:transparent;padding:5px 11px;border-radius:8px;font-size:12.5px;
              color:var(--sub);cursor:pointer;white-space:nowrap;transition:.15s}
  .seg button:hover{color:var(--fg)}
  .seg button.on{background:var(--soft);color:var(--fg);font-weight:600;box-shadow:0 1px 2px rgba(20,20,40,.06)}
  @media (prefers-color-scheme:dark){.seg button.on{background:#26222f;color:#fff}}

  .icon-btn{width:31px;height:31px;padding:0;display:grid;place-items:center;border:1px solid var(--line);
            background:var(--card);border-radius:9px;cursor:pointer;color:var(--sub);box-shadow:var(--shadow)}
  .icon-btn:hover{color:var(--brand);border-color:var(--brand2)}
  .icon-btn svg{width:14px;height:14px}

  /* ------------------------------------------------------------ KPI */
  .kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:11px;margin-bottom:12px}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:13px 14px 10px;
       box-shadow:var(--shadow);min-width:0;display:flex;flex-direction:column;min-height:150px}
  .kpi-top{display:flex;align-items:center;gap:6px;color:var(--sub);font-size:11.5px;margin-bottom:7px;
           white-space:nowrap;overflow:hidden}
  .kpi-top .ico{width:15px;height:15px;border-radius:4px;display:grid;place-items:center;font-size:10px;
                color:var(--brand);background:var(--soft);flex:none}
  .kpi-top .k{overflow:hidden;text-overflow:ellipsis;letter-spacing:.01em}
  .kpi-v{font-size:23px;font-weight:660;letter-spacing:-.025em;font-variant-numeric:tabular-nums;line-height:1.15}
  .kpi-v small{font-size:11.5px;font-weight:500;color:var(--muted);margin-left:3px;letter-spacing:0}
  .kpi-d{font-size:11px;margin-top:2px;font-variant-numeric:tabular-nums}
  .kpi-d.up{color:var(--ok)} .kpi-d.down{color:var(--bad)} .kpi-d.flat{color:var(--muted)}
  .kpi-lines{margin-top:auto;padding-top:8px;display:grid;gap:1px;font-size:10.5px;color:var(--sub);
             line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .kpi-lines .dim{color:var(--muted)}
  .spark{height:26px;margin-top:6px}
  .spark svg{display:block;width:100%;height:26px}

  /* 环形卡 */
  .kpi.ring-card{position:relative}
  .ring-line{display:flex;align-items:center;gap:10px;margin-top:2px}
  .ring{--p:0;--c:var(--brand);width:66px;height:66px;border-radius:50%;flex:none;position:relative;
        background:conic-gradient(var(--c) calc(var(--p)*1%),color-mix(in srgb,var(--fg) 8%,transparent) 0)}
  .ring::after{content:"";position:absolute;inset:6px;border-radius:50%;background:var(--card)}
  .ring .in{position:absolute;inset:0;display:grid;place-content:center;text-align:center;z-index:1}
  .ring .in b{font-size:14px;font-weight:680;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .ring .in span{font-size:9px;color:var(--muted);display:block;margin-top:-1px}
  .ring-meta{font-size:10.5px;color:var(--sub);line-height:1.5}

  /* ------------------------------------------------------------ 面板 */
  .panels{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:12px;margin-bottom:12px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
         box-shadow:var(--shadow);min-width:0;display:flex;flex-direction:column}
  .panel-head{display:flex;align-items:flex-start;gap:10px;padding:13px 15px 10px;flex-wrap:wrap}
  .panel-title{font-size:12.5px;font-weight:640;letter-spacing:.01em}
  .panel-sub{font-size:10.5px;color:var(--muted);margin-top:1px;font-variant-numeric:tabular-nums}
  .panel-link{font-size:10.5px;color:var(--muted);margin-left:auto;white-space:nowrap}
  .tabs{display:flex;gap:2px;margin-left:auto;background:var(--soft);border-radius:8px;padding:2px}
  .tabs button{border:0;background:transparent;padding:4px 9px;border-radius:6px;font-size:11px;color:var(--sub);cursor:pointer}
  .tabs button.on{background:var(--card);color:var(--fg);font-weight:600;box-shadow:0 1px 2px rgba(20,20,40,.08)}
  @media (prefers-color-scheme:dark){.tabs{background:#20202a}.tabs button.on{background:#2f2f3c}}

  .chart-scroll{position:relative;padding:0 8px 6px;overflow-x:auto}
  .chart-scroll svg{display:block;width:100%;height:auto;min-width:560px}
  .legend{display:flex;align-items:center;gap:14px;padding:2px 16px 14px;font-size:10.5px;color:var(--sub)}
  .legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:0}
  .legend i.ln{height:2px;width:12px;border-radius:1px}
  .tip{position:absolute;z-index:6;background:var(--fg);color:var(--card);border-radius:8px;padding:7px 9px;
       font-size:11px;line-height:1.55;pointer-events:none;opacity:0;transition:opacity .12s;white-space:nowrap;
       box-shadow:0 8px 24px -10px rgba(0,0,0,.5)}
  .tip.on{opacity:1}
  .tip b{font-variant-numeric:tabular-nums}

  .feed{flex:1;overflow:auto;padding:0 12px 8px;max-height:324px;min-height:200px}
  .feed.more{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 22px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 22px),transparent)}
  .feed-row{display:flex;align-items:center;gap:7px;padding:6px 3px;border-bottom:1px dashed var(--line);
            font-size:11.5px;min-width:0}
  .feed-row:last-child{border-bottom:0}
  .feed-row .t{color:var(--muted);font-variant-numeric:tabular-nums;flex:none;width:54px;font-size:10.5px}
  .feed-row .mdl{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42%}
  .feed-row .arr{color:var(--muted);flex:none;font-size:10px}
  .feed-row .acc{color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
  .feed-row .rt{color:var(--sub);font-variant-numeric:tabular-nums;white-space:nowrap;flex:none;font-size:10.5px}
  .feed-row .rt b{color:var(--fg);font-weight:600}
  .feed-row.bad .mdl{color:var(--bad)}
  .feed-empty{padding:40px 10px;text-align:center;color:var(--muted);font-size:12px}
  .new-row{animation:slidein .5s ease}
  @keyframes slidein{from{opacity:0;transform:translateY(-5px);background:var(--brand-soft)}to{opacity:1}}

  /* ------------------------------------------------------------ 号池 */
  .pool-section{margin:18px 0 12px}
  .section-head{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:11px}
  h2{font-size:15px;margin:0;font-weight:650;letter-spacing:-.01em}
  .pool-actions{display:flex;gap:8px;margin-left:auto;align-items:center;flex-wrap:wrap}
  select{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:6px 9px;font-size:12px;
         cursor:pointer;box-shadow:var(--shadow)}
  button.primary{background:var(--brand);border:1px solid var(--brand);color:#fff;border-radius:9px;
                 padding:6px 12px;font-size:12.5px;cursor:pointer;box-shadow:0 6px 14px -8px rgba(124,92,255,.9)}
  button.primary:hover{filter:brightness(1.06)}
  button.ghost{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:6px 12px;
               font-size:12.5px;cursor:pointer}
  button.ghost:hover{border-color:var(--brand2);color:var(--brand)}

  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(330px,100%),1fr));gap:11px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:15px;
        box-shadow:var(--shadow);position:relative;overflow:hidden;min-width:0}
  .card.off{opacity:.6}
  .card::before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--st,transparent)}
  .head{display:flex;align-items:center;gap:10px;margin-bottom:13px}
  .avatar{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-weight:650;font-size:14px;
          background:var(--soft);color:var(--brand);flex:none}
  .who{min-width:0;flex:1}
  .name{font-weight:640;font-size:14px;display:flex;align-items:center;gap:5px;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis}
  .meta{color:var(--muted);font-size:11px;display:flex;gap:6px;align-items:center;margin-top:1px}
  .pill{font-size:10.5px;padding:2px 7px;border-radius:999px;font-weight:600;white-space:nowrap;
        display:inline-flex;align-items:center;gap:4px;flex:none}
  .pill i{width:4px;height:4px;border-radius:50%;background:currentColor;display:block}
  .pill.ready{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
  .pill.cooling{color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}
  .pill.unauthorized{color:var(--bad);background:color-mix(in srgb,var(--bad) 12%,transparent)}
  .pill.disabled{color:var(--idle);background:color-mix(in srgb,var(--idle) 16%,transparent)}
  .pill.busy,.pill.exhausted{color:var(--brand);background:var(--soft)}
  .tag{font-size:10px;color:var(--muted);border:1px solid var(--line);border-radius:5px;padding:0 4px;font-weight:500}

  .switch{width:34px;height:20px;border-radius:999px;background:var(--line2);border:none;position:relative;
          cursor:pointer;flex:none;padding:0;transition:.2s}
  .switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
                 background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.25)}
  .switch[aria-checked="true"]{background:var(--ok)}
  .switch[aria-checked="true"]::after{left:16px}

  .quota{display:flex;align-items:center;gap:14px;padding:0 0 12px}
  .ring.sm{width:72px;height:72px}
  .ring.sm::after{inset:6px}
  .ring.sm .in b{font-size:13px}
  .qinfo{min-width:0;flex:1}
  .qline{display:flex;justify-content:space-between;gap:4px 8px;font-size:11.5px;flex-wrap:wrap;min-width:0}
  .qline b{font-variant-numeric:tabular-nums;font-size:12.5px}
  .qline .muted{color:var(--muted)}
  .qline.sub2{font-size:10.5px;margin-top:2px;color:var(--sub)}
  .ring.none{opacity:.4}
  .bar{height:4px;border-radius:999px;background:color-mix(in srgb,var(--fg) 7%,transparent);margin:6px 0 6px;overflow:hidden}
  .bar>span{display:block;height:100%;border-radius:999px;background:var(--c);transition:width .4s}

  .kpis2{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;border-top:1px solid var(--line);
         padding-top:10px;margin-top:1px}
  .kpi2{text-align:center;min-width:0}
  .kpi2 b{display:block;font-size:13px;font-weight:640;font-variant-numeric:tabular-nums;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .kpi2 span{font-size:10px;color:var(--muted);white-space:nowrap}

  .foot{display:flex;align-items:center;gap:5px;margin-top:11px;padding-top:10px;
        border-top:1px solid var(--line);flex-wrap:wrap}
  .foot .grow{flex:1}
  .mini{font-size:11px;padding:4px 8px;border-radius:7px;border:1px solid var(--line);background:var(--card);
        cursor:pointer;white-space:nowrap}
  .mini:hover{border-color:var(--brand2);color:var(--brand)}
  .mini.danger:hover{border-color:var(--bad);color:var(--bad)}
  .stepper{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:7px;overflow:hidden}
  .stepper button{border:0;border-radius:0;padding:3px 7px;background:transparent;cursor:pointer;font-size:12px}
  .stepper button:hover{background:var(--soft);color:var(--brand)}
  .stepper .val{min-width:24px;text-align:center;font-size:11px;font-variant-numeric:tabular-nums;color:var(--sub)}
  .err{color:var(--bad);font-size:10.5px;margin-top:8px;word-break:break-word;line-height:1.4}
  .cd{color:var(--warn);font-size:10.5px;margin-top:8px;font-variant-numeric:tabular-nums}

  /* ------------------------------------------------------------ API 兼容 */
  .api-section{margin:12px 0;padding-bottom:14px;overflow:hidden}
  .api-grid{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(0,.92fr);gap:12px;padding:0 14px}
  .api-card{border:1px solid var(--line);border-radius:12px;padding:13px;background:var(--soft);min-width:0}
  .api-card-head{display:flex;align-items:center;gap:9px}
  .api-icon{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;flex:none;
            background:var(--card);border:1px solid var(--line);color:var(--brand);font-size:15px}
  .api-copy{min-width:0;flex:1}
  .api-name{font-size:12.5px;font-weight:650}
  .api-desc{font-size:10.5px;color:var(--muted);margin-top:1px}
  .api-state{font-size:10.5px;font-weight:650;color:var(--ok)}
  .api-state.off{color:var(--muted)}
  .api-endpoint{display:flex;align-items:center;gap:7px;margin-top:12px;padding:8px 9px;border-radius:8px;
                background:var(--card);border:1px solid var(--line);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
                font-size:10.5px;min-width:0}
  .api-endpoint code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  .api-meta{display:flex;gap:14px;flex-wrap:wrap;margin-top:9px;font-size:10.5px;color:var(--sub)}
  .api-meta b{color:var(--fg);font-weight:600}
  .key-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px dashed var(--line)}
  .key-row:last-child{border-bottom:0}
  .key-dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 13%,transparent)}
  .key-main{min-width:0;flex:1}
  .key-name{font-size:11.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .key-time{font-size:9.5px;color:var(--muted);margin-top:1px}
  .key-empty{padding:12px 2px;font-size:10.5px;color:var(--muted);line-height:1.6}
  .api-actions{display:flex;align-items:center;gap:7px;margin-top:8px}
  .api-actions .grow{flex:1}
  .key-secret{display:flex;gap:7px;margin-top:10px}
  .key-secret input{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
  .key-secret button{white-space:nowrap;border:1px solid var(--line);background:var(--card);border-radius:8px;
                     padding:0 10px;cursor:pointer;font-size:11px}
  .key-warning{margin-top:9px!important;padding:8px 9px;border-radius:8px;color:var(--warn)!important;
               background:color-mix(in srgb,var(--warn) 10%,transparent);font-size:10.5px!important}

  /* ------------------------------------------------------------ 热力图 */
  .heat-panel{margin-top:12px;padding-bottom:12px}
  .heat-inner{display:flex;gap:22px;padding:2px 16px 4px;align-items:flex-start;flex-wrap:wrap}
  .heat-main{min-width:0;flex:1;overflow-x:auto}
  .heat-months{position:relative;height:15px;margin-left:22px;min-width:520px}
  .heat-months span{position:absolute;top:0;font-size:10px;color:var(--muted);white-space:nowrap}
  .heat-body{display:flex;gap:5px;min-width:520px}
  .heat-days{display:flex;flex-direction:column;gap:3px;width:16px;flex:none;padding-top:0}
  .heat-days span{height:10px;line-height:10px;font-size:9px;color:var(--muted);text-align:right}
  .heat-grid{display:flex;gap:3px}
  .heat-col{display:flex;flex-direction:column;gap:3px}
  .cell{width:10px;height:10px;border-radius:2px;background:var(--h0)}
  .cell.l1{background:var(--h1)} .cell.l2{background:var(--h2)} .cell.l3{background:var(--h3)} .cell.l4{background:var(--h4)}
  .cell.null{background:transparent}
  .heat-stats{display:grid;grid-template-columns:repeat(2,minmax(76px,1fr));gap:12px 20px;flex:none;padding-top:2px}
  .hs b{display:block;font-size:18px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .hs span{font-size:10.5px;color:var(--muted)}
  .heat-foot{display:flex;align-items:center;gap:10px;padding:8px 16px 0;flex-wrap:wrap}
  .heat-note{font-size:10.5px;color:var(--muted)}
  .heat-legend{margin-left:auto;display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted)}
  .heat-legend i{width:10px;height:10px;border-radius:2px;display:block}

  .empty{background:var(--card);border:1px dashed var(--line2);border-radius:var(--radius);
         padding:44px 20px;text-align:center}
  .empty h3{margin:0 0 5px;font-size:15px}
  .empty p{color:var(--sub);margin:0 0 16px;font-size:12.5px}

  .footnote{margin-top:18px;color:var(--muted);font-size:11px;line-height:1.75}
  .footnote code{background:color-mix(in srgb,var(--fg) 7%,transparent);padding:1px 5px;border-radius:5px}
  .footnote b{color:var(--sub)}

  .mask{position:fixed;inset:0;background:rgba(10,10,16,.5);backdrop-filter:blur(3px);
        display:none;align-items:center;justify-content:center;padding:18px;z-index:50}
  .mask.on{display:flex}
  .modal{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:19px;
         width:min(440px,100%);box-shadow:0 30px 80px -20px rgba(0,0,0,.5)}
  .modal h2{margin:0 0 4px;font-size:15px}
  .modal p{color:var(--sub);font-size:12px;margin:0 0 14px;line-height:1.6}
  .modal input{width:100%;background:var(--bg);border:1px solid var(--line2);border-radius:9px;
               padding:8px 10px;font-size:13.5px;outline:none}
  .modal input:focus{border-color:var(--brand)}
  .modal .row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
  .modal .row button{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:6px 13px;cursor:pointer;font-size:12.5px}
  .modal .row button.primary{border-color:var(--brand)}
  .qrbox{margin-top:12px;border-radius:12px;overflow:hidden;border:1px solid var(--line);background:#fff}
  .qrbox iframe{width:100%;height:min(500px,62vh);border:0;display:block}
  .toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,14px);opacity:0;pointer-events:none;
         background:#17171e;color:#fff;padding:8px 15px;border-radius:10px;font-size:12.5px;z-index:80;
         transition:.22s;max-width:90vw}
  .toast.on{opacity:1;transform:translate(-50%,0)}
  .toast.bad{background:#b91c1c}

  @media(max-width:1180px){
    .kpis{grid-template-columns:repeat(3,minmax(0,1fr))}
    .panels{grid-template-columns:minmax(0,1fr)}
    .feed{max-height:260px}
  }
  @media(max-width:720px){
    .wrap{padding:16px 13px 44px}
    header{gap:10px}
    .head-right{width:100%}
    .seg{overflow-x:auto;width:100%;justify-content:flex-start}
    .seg button{padding:5px 9px;font-size:12px}
    .kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
    .kpi{min-height:140px;padding:11px 12px 8px}
    .kpi-v{font-size:20px}
    .kpi-lines{font-size:10px}
    .grid{grid-template-columns:minmax(0,1fr)}
    .kpis2{gap:4px}
    .heat-inner{gap:14px}
    .heat-stats{grid-template-columns:repeat(2,1fr);gap:10px 24px}
    .feed-row .mdl{max-width:36%}
    .api-grid{grid-template-columns:minmax(0,1fr);padding:0 11px}
  }
</style></head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      <div class="logo">W</div>
      <div>
        <h1>数据看板</h1>
        <div class="sub" id="head-sub">正在加载…</div>
      </div>
    </div>
    <div class="grow"></div>
    <div class="head-right">
      <div class="seg" id="ranges">
        <button data-range="today" class="on">今日</button>
        <button data-range="3d">近 3 日</button>
        <button data-range="week">本周</button>
        <button data-range="month">本月</button>
        <button data-range="30d">近 30 天</button>
        <button data-range="all">全部</button>
      </div>
      <button class="icon-btn" id="btn-refresh" title="刷新">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>
        </svg>
      </button>
    </div>
  </header>

  <section class="kpis" id="kpis"></section>

  <section class="panels">
    <div class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">TOKEN 时序</div>
          <div class="panel-sub" id="chart-sub"></div>
        </div>
        <div class="tabs" id="metrics">
          <button data-metric="tokens" class="on">Token</button>
          <button data-metric="req">请求数</button>
          <button data-metric="throughput">吞吐量</button>
        </div>
      </div>
      <div class="chart-scroll">
        <div id="chart"></div>
        <div class="tip" id="tip"></div>
      </div>
      <div class="legend" id="legend"></div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">最近请求</div>
          <div class="panel-sub">实时活动流</div>
        </div>
        <div class="panel-link" id="feed-sub"></div>
      </div>
      <div class="feed" id="feed"></div>
    </div>
  </section>

  <section class="pool-section">
    <div class="section-head">
      <div>
        <h2>账号池</h2>
        <div class="sub" id="pool-sub"></div>
      </div>
      <div class="pool-actions">
        <select id="strategy" title="调度策略">
          <option value="balanced">均衡分配</option>
          <option value="round-robin">加权轮询</option>
        </select>
        <button class="primary" id="btn-add">+ 添加账号</button>
      </div>
    </div>
    <div class="grid" id="grid"></div>
    <div id="empty"></div>
  </section>

  <section class="panel api-section" id="api-compat">
    <div class="panel-head">
      <div>
        <div class="panel-title">API 兼容</div>
        <div class="panel-sub">直接使用 WorkBuddy 上游与号池，不启动 CLI</div>
      </div>
      <div class="panel-link">Anthropic Messages API</div>
    </div>
    <div class="api-grid">
      <div class="api-card">
        <div class="api-card-head">
          <div class="api-icon">A</div>
          <div class="api-copy">
            <div class="api-name">Anthropic 协议</div>
            <div class="api-desc">支持流式文本、tool_use 与 count_tokens</div>
          </div>
          <span class="api-state" id="api-state">关闭</span>
          <button class="switch" id="api-switch" role="switch" aria-checked="false" data-act="api-toggle" title="启用/停用 Anthropic API"></button>
        </div>
        <div class="api-endpoint">
          <code id="api-endpoint"></code>
          <button class="mini" data-act="api-copy-endpoint" title="复制接口地址">复制</button>
        </div>
        <div class="api-meta" id="api-meta"></div>
      </div>
      <div class="api-card">
        <div class="api-card-head">
          <div class="api-icon">#</div>
          <div class="api-copy">
            <div class="api-name">客户端密钥</div>
            <div class="api-desc">仅保存 SHA-256 摘要，明文只显示一次</div>
          </div>
          <button class="mini danger" data-act="api-key-reset">重置全部</button>
          <button class="ghost" data-act="api-key-create">生成新 Key</button>
        </div>
        <div id="api-keys"></div>
      </div>
    </div>
  </section>

  <section class="panel heat-panel">
    <div class="panel-head">
      <div>
        <div class="panel-title">工作回潮</div>
        <div class="panel-sub">近一年每日活动</div>
      </div>
      <div class="panel-link" id="heat-sub"></div>
    </div>
    <div class="heat-inner">
      <div class="heat-main">
        <div class="heat-months" id="heat-months"></div>
        <div class="heat-body">
          <div class="heat-days"><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span>日</span></div>
          <div class="heat-grid" id="heat"></div>
        </div>
      </div>
      <div class="heat-stats" id="heat-stats"></div>
    </div>
    <div class="heat-foot">
      <div class="heat-note" id="heat-note"></div>
      <div class="heat-legend">少
        <i style="background:var(--h0)"></i><i style="background:var(--h1)"></i>
        <i style="background:var(--h2)"></i><i style="background:var(--h3)"></i>
        <i style="background:var(--h4)"></i> 多
      </div>
    </div>
  </section>

  <div class="footnote">
    调度顺序：先排除<b>停用 / 未登录 / 冷却中 / 并发已满 / 当日预算用尽</b>的账号，
    再按 <b>空闲 → 权重归一后的 token 用量 → 最久未使用</b> 排序取第一个。
    任务失败且尚未产出内容时自动换号，最多 3 次。<br/>
    用量口径：token 来自 <code>stream-json</code> 的 <code>usage</code> 实测累计（<code>input_tokens</code> 已含缓存读，不重复相加）；
    额度只有设了每日预算才能算出「剩余」，否则只显示用量。
    ${process.env.WB_PRICE_IN || process.env.WB_PRICE_OUT ? '' : '「API 等价」需要配置 <code>WB_PRICE_IN</code> / <code>WB_PRICE_OUT</code>（元/百万 token）才会估算。'}
    数据目录：<code>${esc(home || '~/.workbuddy-bridge')}</code>
  </div>
</div>

<div class="mask" id="mask"><div class="modal" id="modal"></div></div>
<div class="toast" id="toast"></div>

<script>
var TOKEN=${JSON.stringify(token || '')};
var $=function(id){return document.getElementById(id)};
var state={pool:null,stats:null,api:null,range:'today',metric:'tokens',hover:false};
var timer=null,loginPoll=null,lastEventSeq=0,firstPaint=true;

function api(path,opts){
  opts=opts||{};
  opts.headers=Object.assign({'content-type':'application/json'},opts.headers||{});
  if(TOKEN) opts.headers['x-wb-token']=TOKEN;
  return fetch(path,opts).then(function(r){
    return r.json().then(function(j){
      if(!r.ok||j.ok===false) throw new Error(j.error||('HTTP '+r.status));
      return j;
    });
  });
}
function toast(msg,bad){
  var t=$('toast'); t.textContent=msg; t.className='toast on'+(bad?' bad':'');
  clearTimeout(t._t); t._t=setTimeout(function(){t.className='toast'},2600);
}

/* ------------------------------------------------------------ 格式化 */
function num(n){
  if(n===null||n===undefined) return '—';
  n=Number(n);
  if(!isFinite(n)) return '—';
  var a=Math.abs(n);
  if(a>=1e9) return (n/1e9).toFixed(2)+'B';
  if(a>=1e6) return (n/1e6).toFixed(1)+'M';
  if(a>=1e4) return (n/1e3).toFixed(1)+'K';
  if(a>=1e3) return (n/1e3).toFixed(2)+'K';
  if(a>0&&a<10&&a%1!==0) return n.toFixed(1);
  return String(Math.round(n));
}
function int(n){ return (Math.round(Number(n)||0)).toLocaleString('zh-CN') }
function pct(v,d){ return v===null||v===undefined?'—':(v*100).toFixed(d===undefined?1:d)+'%' }
function dur(ms){
  if(!ms) return '0s';
  if(ms<1000) return Math.round(ms)+'ms';
  if(ms<60000) return (ms/1000).toFixed(1)+'s';
  return Math.round(ms/60000)+'m';
}
function clock(ts){
  var d=new Date(ts), p=function(n){return String(n).padStart(2,'0')};
  return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}
function hhmm(ts){
  var d=new Date(ts), p=function(n){return String(n).padStart(2,'0')};
  return p(d.getHours())+':'+p(d.getMinutes());
}
function mmdd(ts){
  var d=new Date(ts), p=function(n){return String(n).padStart(2,'0')};
  return p(d.getMonth()+1)+'-'+p(d.getDate());
}
function ago(ts){
  if(!ts) return '';
  var d=Date.now()-ts;
  if(d<60000) return '刚刚用过';
  if(d<3600000) return Math.floor(d/60000)+' 分钟前用过';
  if(d<86400000) return Math.floor(d/3600000)+' 小时前用过';
  return Math.floor(d/86400000)+' 天前用过';
}
function initials(name){
  var s=String(name||'?').trim();
  return (s[0]||'?').toUpperCase();
}
function h(s){
  return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function deltaHtml(v){
  if(v===null||v===undefined||!isFinite(v)) return '<span class="kpi-d flat">环比 —</span>';
  if(Math.abs(v)<0.0005) return '<span class="kpi-d flat">— 持平</span>';
  var up=v>=0;
  return '<span class="kpi-d '+(up?'up':'down')+'">'+(up?'▲':'▼')+' '+Math.abs(v*100).toFixed(1)+'%</span>';
}

/* ------------------------------------------------------------ 迷你图 */
function sparkline(points,key,color){
  var vals=(points||[]).map(function(p){return Number(p[key])||0});
  if(vals.length<2) vals=vals.concat([0,0]);
  var w=120,h=26,pad=2;
  var max=Math.max.apply(null,vals.concat([1]));
  var step=vals.length>1?w/(vals.length-1):w;
  var pts=vals.map(function(v,i){
    return (i*step).toFixed(1)+','+(h-pad-(v/max)*(h-pad*2)).toFixed(1);
  });
  var line=pts.join(' ');
  var area='0,'+h+' '+line+' '+w+','+h;
  return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" aria-hidden="true">'+
    '<polygon points="'+area+'" fill="'+color+'" opacity=".10"/>'+
    '<polyline points="'+line+'" fill="none" stroke="'+color+'" stroke-width="1.6" '+
    'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'+
  '</svg>';
}

/* ------------------------------------------------------------ KPI */
function kpiCard(o){
  return '<div class="kpi">'+
    '<div class="kpi-top"><span class="ico">'+o.icon+'</span><span class="k">'+o.label+'</span></div>'+
    '<div class="kpi-v">'+o.value+(o.unit?'<small>'+o.unit+'</small>':'')+'</div>'+
    (o.delta!==undefined?deltaHtml(o.delta):'')+
    '<div class="kpi-lines">'+
      o.lines.map(function(x,i){return '<div'+(i?' class="dim"':'')+'>'+x+'</div>'}).join('')+
    '</div>'+
    (o.spark?'<div class="spark">'+o.spark+'</div>':'')+
  '</div>';
}
function ringCard(o){
  return '<div class="kpi ring-card">'+
    '<div class="kpi-top"><span class="ico">'+o.icon+'</span><span class="k">'+o.label+'</span></div>'+
    '<div class="ring-line">'+
      '<div class="ring" style="--p:'+o.percent+';--c:'+o.color+'"><div class="in"><b>'+o.value+'</b><span>'+o.caption+'</span></div></div>'+
      '<div class="ring-meta">'+o.meta+'</div>'+
    '</div>'+
  '</div>';
}

function renderHead(){
  var s=state.stats, t=s.totals;
  $('head-sub').innerHTML='区间 <b>'+num(t.tokens)+'</b> tokens · <b>'+int(t.req)+'</b> 次请求 · 更新于 '+clock(s.generatedAt);
}

function renderKpis(){
  var s=state.stats, t=s.totals, d=s.deltas||{};
  var pts=s.series;
  var rate=t.successRate;
  var succColor=rate===null?'var(--idle)':rate>=0.98?'var(--ok)':rate>=0.9?'var(--warn)':'var(--bad)';

  var costValue=t.costCny===null||t.costCny===undefined?'—':'¥'+t.costCny.toFixed(2);
  var costLines;
  if(t.costSource==='cli') costLines=['CLI 上报 $'+Number(t.costUsd||0).toFixed(2),'按 1 USD = '+s.price.usdCny+' 元折算'];
  else if(t.costSource==='price') costLines=['按配置单价估算','输入 ¥'+s.price.pin+'/M · 输出 ¥'+s.price.pout+'/M'];
  else costLines=['CLI 未上报计价','设置 WB_PRICE_IN/OUT 可估算'];

  $('kpis').innerHTML=
    kpiCard({
      icon:'◈', label:'TOKEN 消耗', value:num(t.tokens),
      delta:d.tokens,
      lines:['输入 '+num(t.tin)+' · 输出 '+num(t.tout),'缓存读 '+num(t.cacheRead)+' · 新输入 '+num(t.freshIn)],
      spark:sparkline(pts,'tokens','var(--brand)')
    })+
    kpiCard({
      icon:'≋', label:'请求数', value:int(t.req), unit:'次',
      delta:d.req,
      lines:['失败 '+int(t.fail)+' · 成功率 '+pct(t.successRate),'活跃账号 '+int(t.activeAccounts)+' 个'],
      spark:sparkline(pts,'req','var(--brand)')
    })+
    kpiCard({
      icon:'⚡', label:'生成速度', value:(t.throughput||0).toFixed(1), unit:'tok/s',
      delta:undefined,
      lines:['平均耗时 '+dur(t.avgMs)+' · 单次 '+num(t.avgTokens)+' tok','峰值 '+Math.round(t.peakThroughput)+' tok/s · 按任务时长'],
      spark:sparkline(pts,'throughput','var(--brand)')
    })+
    kpiCard({
      icon:'❄', label:'缓存命中率', value:pct(t.cacheHitRate,1),
      delta:d.cacheHitRate,
      lines:['缓存复用 '+num(t.cacheRead)+' tokens','缓存写入 '+num(t.cacheWrite)+' tokens'],
      spark:sparkline(pts,'cacheRead','var(--brand)')
    })+
    kpiCard({
      icon:'¥', label:'API 等价', value:costValue,
      delta:d.cost,
      lines:costLines,
      spark:sparkline(pts,'tokens','var(--brand)')
    })+
    ringCard({
      icon:'◔', label:'请求成功率',
      percent:rate===null?0:Math.round(rate*100),
      value:rate===null?'—':(rate>=1?'100%':rate>=0.999?(rate*100).toFixed(2)+'%':(rate*100).toFixed(1)+'%'),
      caption:'成功', color:succColor,
      meta:int(t.ok)+' 次成功<br/>'+int(t.fail)+' 次失败'
    });
}

/* ------------------------------------------------------------ 时序图 */
// 先算「每格步长」再乘格数，比直接对总量取整更贴数据，顶部留白不会过大
function niceStep(v){
  if(!v||v<=0) return 1;
  var exp=Math.pow(10,Math.floor(Math.log10(v)));
  var f=v/exp;
  var nf=f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10;
  return nf*exp;
}
function niceMax(v){
  if(!v||v<=0) return 1;
  return niceStep(v/4)*4;
}

function renderChart(){
  var s=state.stats, pts=s.series, metric=state.metric;
  var W=760,H=246,L=52,R=12,T=12,B=26;
  var iw=W-L-R, ih=H-T-B;
  var n=Math.max(pts.length,1);
  var vals=pts.map(function(p){ return metric==='tokens'?p.tokens:metric==='req'?p.req:p.throughput });
  var max=niceMax(Math.max.apply(null,vals.concat([1])));
  var stepX=iw/n;
  var bw=Math.max(1,Math.min(30,stepX*0.54));

  var grid='',labels='';
  for(var g=0;g<=4;g++){
    var y=T+ih-(ih*g/4);
    var v=max*g/4;
    grid+='<line x1="'+L+'" y1="'+y.toFixed(1)+'" x2="'+(W-R)+'" y2="'+y.toFixed(1)+'" stroke="var(--line)" stroke-width="1"/>';
    labels+='<text x="'+(L-7)+'" y="'+(y+3.5).toFixed(1)+'" text-anchor="end" font-size="9.5" fill="var(--muted)">'+num(v)+'</text>';
  }

  var bars='',hits='';
  for(var i=0;i<pts.length;i++){
    var p=pts[i];
    var val=metric==='tokens'?p.tokens:metric==='req'?p.req:p.throughput;
    var h=(val/max)*ih;
    var x=L+i*stepX+(stepX-bw)/2;
    var y=T+ih-h;
    if(h>0){
      bars+='<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h.toFixed(1)+'" '+
            'rx="1.6" fill="var(--brand2)" opacity="'+(p.fail&&p.req&&p.fail>=p.ok?0.55:0.85)+'"/>';
    }
    hits+='<rect class="hit" data-i="'+i+'" x="'+(L+i*stepX).toFixed(1)+'" y="'+T+'" width="'+stepX.toFixed(1)+'" height="'+ih+'" fill="transparent"/>';
  }

  // Token 视图叠一条请求数折线：量级不同，各自归一化，只看形状
  var line='';
  if(metric==='tokens'){
    var rmax=niceMax(Math.max.apply(null,pts.map(function(p){return p.req}).concat([1])));
    var lp=pts.map(function(p,i){
      var yy=T+ih-((p.req||0)/rmax)*ih;
      return (L+i*stepX+stepX/2).toFixed(1)+','+yy.toFixed(1);
    }).join(' ');
    line='<polyline points="'+lp+'" fill="none" stroke="var(--brand-deep)" stroke-width="1.5" '+
         'stroke-linejoin="round" stroke-linecap="round" opacity=".85"/>';
  }

  // x 轴标签按点数抽稀，避免挤成一团
  var every=Math.max(1,Math.ceil(n/8));
  var xlabels='';
  for(var j=0;j<pts.length;j+=every){
    var tx=L+j*stepX+stepX/2;
    var lab=s.granularity==='hour'?hhmm(pts[j].ts):mmdd(pts[j].ts);
    xlabels+='<text x="'+tx.toFixed(1)+'" y="'+(H-8)+'" text-anchor="middle" font-size="9.5" fill="var(--muted)">'+lab+'</text>';
  }

  $('chart').innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="用量时序">'+grid+bars+line+hits+xlabels+labels+'</svg>';
  $('chart').setAttribute('data-n',String(pts.length));

  var unitText=metric==='tokens'?'Token 总量':metric==='req'?'请求数':'tok/s';
  $('legend').innerHTML='<span><i style="background:var(--brand2)"></i>'+unitText+'</span>'+
    (metric==='tokens'?'<span><i class="ln" style="background:var(--brand-deep)"></i>请求数</span>':'');

  var from=pts.length?pts[0].ts:s.from, to=pts.length?pts[pts.length-1].ts:s.to;
  $('chart-sub').textContent=mmdd(from)+' '+hhmm(from)+' — '+mmdd(to)+' '+hhmm(to)+
    ' · '+(s.granularity==='hour'?'小时':'每天')+'粒度 · 总 '+num(s.totals.tokens)+' tok / '+int(s.totals.req)+' 请求';
}

/* ------------------------------------------------------------ 请求流 */
function renderFeed(){
  var s=state.stats, ev=s.events||[];
  $('feed-sub').textContent=ev.length?('共 '+ev.length+' 条记录'):'';
  if(!ev.length){
    $('feed').innerHTML='<div class="feed-empty">这个区间还没有调用记录<br/>把任务交给 WorkBuddy 后会实时出现在这里</div>';
    return;
  }
  var newest=ev[0].seq;
  var animate=!firstPaint&&newest>lastEventSeq;
  lastEventSeq=Math.max(lastEventSeq,newest);

  $('feed').innerHTML=ev.map(function(e){
    var tokens=(e.tin||0)+(e.tout||0);
    var isNew=animate&&e.seq===newest;
    return '<div class="feed-row'+(e.ok?'':' bad')+(isNew?' new-row':'')+'">'+
      '<span class="t">'+clock(e.at)+'</span>'+
      '<span class="mdl">'+(e.model||'auto')+'</span>'+
      '<span class="arr">→</span>'+
      '<span class="acc">'+e.account+'</span>'+
      '<span class="rt"><b>'+num(tokens)+'</b> tok · '+dur(e.ms)+'</span>'+
    '</div>';
  }).join('');

  // 内容超过容器时给底部一个渐隐，避免最后一行露半截显得脏
  var f=$('feed');
  requestAnimationFrame(function(){
    f.classList.toggle('more', f.scrollHeight > f.clientHeight + 2);
  });
}

/* ------------------------------------------------------------ 号池 */
function ringColor(a){
  if(a.status==='cooling') return 'var(--warn)';
  if(a.status!=='ready') return 'var(--idle)';
  var p=a.quota&&a.quota.percent;
  if(p===null||p===undefined) return 'var(--brand)';
  if(p>=90) return 'var(--bad)';
  if(p>=70) return 'var(--warn)';
  return 'var(--ok)';
}
function pill(a){
  return '<span class="pill '+a.status+'"><i></i>'+a.statusText+'</span>';
}
function card(a){
  var q=a.quota||{}, limit=q.limit||0, used=q.used||0, rem=q.remaining;
  var fill,centerBig,centerSmall,qline;
  if(limit>0){
    fill=rem===null?100:Math.max(0,Math.round((rem/limit)*100));
    centerBig=pct(rem===null?null:rem/limit);
    centerSmall='剩余';
    qline='<div class="qline"><span class="muted">剩余额度</span><b style="color:'+ringColor(a)+'">'+num(rem)+
          ' <span class="muted">/ '+num(limit)+'</span></b></div>'+
          '<div class="qline sub2"><span>今日已用 '+num(used)+' tok</span><span>'+a.today.req+' 次</span></div>';
  }else{
    fill=100;
    centerBig=used?num(used):'—';
    centerSmall='今日 tokens';
    qline='<div class="qline"><span class="muted">今日已用</span><b>'+num(used)+
          ' <span class="muted">tok</span></b></div>'+
          '<div class="qline sub2"><span>未设每日预算</span><span>'+a.today.req+' 次</span></div>';
  }
  var cd=a.cooldownLeftMs>0?'<div class="cd" data-until="'+(Date.now()+a.cooldownLeftMs)+'">冷却剩余 '+Math.ceil(a.cooldownLeftMs/1000)+'s</div>':'';
  var err=a.lastError?'<div class="err">'+String(a.lastError).replace(/</g,'&lt;')+'</div>':'';
  var sub=a.lastUsedAt?ago(a.lastUsedAt):a.auth;
  var cacheRate=a.today.cacheHitRate;

  return '<div class="card'+(a.enabled?'':' off')+'" style="--st:'+ringColor(a)+'">'+
    '<div class="head">'+
      '<div class="avatar">'+initials(a.name)+'</div>'+
      '<div class="who"><div class="name">'+a.name+
        (a.isDefault?' <span class="tag">默认</span>':'')+
        (a.model?' <span class="tag">'+a.model+'</span>':'')+
      '</div><div class="meta">'+sub+'</div></div>'+
      pill(a)+
      '<button class="switch" role="switch" aria-checked="'+(a.enabled?'true':'false')+'" data-act="toggle" data-name="'+a.name+'" title="启用/停用"></button>'+
    '</div>'+
    '<div class="quota">'+
      '<div class="ring sm'+(limit?'':' none')+'" style="--p:'+fill+';--c:'+ringColor(a)+'"><div class="in">'+
        '<b>'+centerBig+'</b><span>'+centerSmall+'</span></div></div>'+
      '<div class="qinfo">'+qline+
        '<div class="bar"><span style="width:'+(limit?Math.max(2,Math.min(100,100-fill)):0)+'%;background:'+ringColor(a)+'"></span></div>'+
        '<div class="qline sub2"><span>缓存 '+(cacheRate===null?'—':pct(cacheRate,0))+'</span><span>'+dur(a.today.avgMs)+' 均耗时</span></div>'+
      '</div>'+
    '</div>'+
    '<div class="kpis2">'+
      '<div class="kpi2"><b>'+a.today.req+'</b><span>今日请求</span></div>'+
      '<div class="kpi2"><b>'+pct(a.today.successRate)+'</b><span>成功率</span></div>'+
      '<div class="kpi2"><b>'+num(a.today.tokens)+'</b><span>今日 token</span></div>'+
      '<div class="kpi2"><b>'+a.inflight+'/'+a.maxConcurrency+'</b><span>并发</span></div>'+
    '</div>'+
    '<div class="foot">'+
      '<button class="mini" data-act="login" data-name="'+a.name+'">扫码登录</button>'+
      '<button class="mini" data-act="test" data-name="'+a.name+'">测试</button>'+
      '<button class="mini" data-act="budget" data-name="'+a.name+'">预算</button>'+
      (a.cooldownLeftMs>0?'<button class="mini" data-act="reset" data-name="'+a.name+'">重置冷却</button>':'')+
      '<span class="grow"></span>'+
      '<span class="stepper" title="权重：越高分到的任务越多">'+
        '<button data-act="w-" data-name="'+a.name+'">−</button>'+
        '<span class="val">×'+a.weight+'</span>'+
        '<button data-act="w+" data-name="'+a.name+'">+</button>'+
      '</span>'+
      '<button class="mini danger" data-act="remove" data-name="'+a.name+'">删除</button>'+
    '</div>'+
    cd+err+
  '</div>';
}

function renderPool(){
  var p=state.pool;
  if(!p) return;
  $('strategy').value=p.strategy;
  var s=p.summary;
  $('pool-sub').innerHTML=s.available+'/'+s.total+' 可用 · 今日 '+num(s.todayTokens)+' tokens · '+
    int(s.todayReq)+' 次请求 · '+p.strategyText;

  if(!p.accounts.length){
    $('grid').innerHTML='';
    $('empty').style.display='block';
    $('empty').innerHTML='<div class="empty"><h3>还没有账号</h3>'+
      '<p>扫码添加第一个 WorkBuddy 账号，之后可以继续加号组成号池。</p>'+
      '<button class="primary" data-act="add">+ 添加账号</button></div>';
    return;
  }
  $('empty').style.display='none';
  $('grid').innerHTML=p.accounts.map(card).join('');
}

/* ------------------------------------------------------------ API 兼容 */
function renderApi(){
  var s=state.api;
  if(!s) return;
  var enabled=!!(s.enabled&&s.anthropicEnabled);
  $('api-state').textContent=enabled?'已启用':'已关闭';
  $('api-state').className='api-state'+(enabled?'':' off');
  $('api-switch').setAttribute('aria-checked',enabled?'true':'false');
  $('api-endpoint').textContent=location.origin+'/v1/messages';
  var authMode=s.requireApiKey?'所有连接强制 Key':
    !s.remoteRequireKey?'不强制 Key':
    s.trustProxy?'可信代理强制 Key':'回环免 Key · 远程强制 Key';
  $('api-meta').innerHTML=
    '<span>鉴权 <b>'+authMode+'</b></span>'+
    '<span>流超时 <b>'+Math.round(s.idleTimeoutMs/1000)+'s</b></span>'+
    '<span>DSML 上限 <b>'+num(s.dsmlMaxBufferBytes)+' B</b></span>';
  var keys=Array.isArray(s.keys)?s.keys:[];
  if(!keys.length){
    $('api-keys').innerHTML='<div class="key-empty">还没有客户端 Key。回环地址可直接调试；远程调用请先生成 Key。</div>';
    return;
  }
  $('api-keys').innerHTML=keys.map(function(k){
    var when=k.createdAt?new Date(k.createdAt).toLocaleString('zh-CN'):'';
    return '<div class="key-row"><span class="key-dot"></span><div class="key-main">'+
      '<div class="key-name">'+h(k.name||'default')+'</div>'+
      '<div class="key-time">sk-wb_•••••••• · '+when+'</div></div>'+
      '<button class="mini danger" data-act="api-key-delete" data-id="'+k.id+'">删除</button></div>';
  }).join('');
}

/* ------------------------------------------------------------ 热力图 */
function renderHeat(){
  var h=state.stats.heatmap;
  var raw=[],last=-1;
  h.weeks.forEach(function(w,i){
    var d=null;
    for(var k=0;k<w.length;k++) if(w[k]){d=w[k];break}
    if(!d) return;
    var m=new Date(d.ts).getMonth();
    if(m!==last){raw.push({i:i,label:(m+1)+'月'});last=m}
  });
  // 离下一个月份标签太近的丢掉，避免「10月」「11月」叠在一起
  var months=raw.filter(function(x,idx){
    return idx===raw.length-1 || raw[idx+1].i - x.i >= 3;
  });

  $('heat-months').innerHTML=months.map(function(m){
    return '<span style="left:'+(m.i*13)+'px">'+m.label+'</span>';
  }).join('');

  var scale=h.scale||1;
  $('heat').innerHTML=h.weeks.map(function(w){
    return '<div class="heat-col">'+w.map(function(c){
      if(!c) return '<div class="cell null"></div>';
      var r=c.tokens/scale;
      var lv=c.tokens<=0?0:r<0.25?1:r<0.55?2:r<0.9?3:4;
      var tip=c.key+' · '+num(c.tokens)+' tok · '+int(c.req)+' 次';
      return '<div class="cell l'+lv+'" title="'+tip+'"></div>';
    }).join('')+'</div>';
  }).join('');

  $('heat-stats').innerHTML=
    '<div class="hs"><b>'+int(h.activeDays)+'</b><span>天有活动</span></div>'+
    '<div class="hs"><b>'+int(h.totalReq)+'</b><span>总请求</span></div>'+
    '<div class="hs"><b>'+num(h.totalTokens)+'</b><span>总 Token</span></div>'+
    '<div class="hs"><b>'+(h.peak?num(h.peak.tokens):'—')+'</b><span>峰值单日</span></div>';

  $('heat-sub').textContent=(h.from||'')+' — '+(h.to||'');
  $('heat-note').textContent='一年共 '+num(h.totalTokens)+' tokens'+(h.peak?' · 峰值为 '+h.peak.key+'（'+num(h.peak.tokens)+'）':'');
}

/* ------------------------------------------------------------ 总渲染 */
function render(){
  if(!state.stats||!state.pool||!state.api) return;
  renderHead();
  renderKpis();
  renderChart();
  renderFeed();
  renderPool();
  renderApi();
  renderHeat();
  firstPaint=false;
}

function load(){
  var range=state.range;
  return Promise.all([
    api('/api/pool'),
    api('/api/stats?range='+encodeURIComponent(range)),
    api('/api/api-compat')
  ]).then(function(res){
    state.pool=res[0];
    state.stats=res[1];
    state.api=res[2];
    render();
  }).catch(function(e){
    toast('加载失败：'+e.message,true);
  });
}

function act(fn){
  fn().then(function(){ return load() }).catch(function(e){ toast(e.message,true) });
}

/* ------------------------------------------------------------ 交互 */
document.addEventListener('click',function(ev){
  var r=ev.target.closest('[data-range]');
  if(r){
    document.querySelectorAll('#ranges button').forEach(function(b){b.classList.toggle('on',b===r)});
    state.range=r.getAttribute('data-range');
    load();
    return;
  }
  var m=ev.target.closest('[data-metric]');
  if(m){
    document.querySelectorAll('#metrics button').forEach(function(b){b.classList.toggle('on',b===m)});
    state.metric=m.getAttribute('data-metric');
    renderChart();
    return;
  }
  var el=ev.target.closest('[data-act]');
  if(!el) return;
  var a=el.getAttribute('data-act'), name=el.getAttribute('data-name');
  if(a==='add') return openAdd();
  if(a==='api-toggle'){
    var apiOn=el.getAttribute('aria-checked')==='true';
    return act(function(){
      return api('/api/api-compat',{method:'PATCH',body:JSON.stringify({anthropic:!apiOn})})
        .then(function(){toast(!apiOn?'Anthropic API 已启用':'Anthropic API 已关闭')});
    });
  }
  if(a==='api-key-create'){
    el.disabled=true;
    return api('/api/api-compat/keys',{method:'POST',body:JSON.stringify({name:'dashboard'})})
      .then(function(j){ return load().then(function(){ openApiKey(j.key) }) })
      .catch(function(e){ toast(e.message,true) })
      .then(function(){ el.disabled=false });
  }
  if(a==='api-key-reset'){
    if(!confirm('重置全部客户端 Key？现有客户端会立即无法访问 API。')) return;
    el.disabled=true;
    return api('/api/api-compat/keys/reset',{method:'POST',body:JSON.stringify({name:'dashboard-reset'})})
      .then(function(j){ return load().then(function(){ openApiKey(j.key) }) })
      .catch(function(e){ toast(e.message,true) })
      .then(function(){ el.disabled=false });
  }
  if(a==='api-key-delete'){
    var keyId=el.getAttribute('data-id');
    if(!confirm('删除这个客户端 Key？使用它的客户端会立即无法访问 API。')) return;
    return act(function(){
      return api('/api/api-compat/keys/'+encodeURIComponent(keyId),{method:'DELETE'})
        .then(function(){toast('客户端 Key 已删除')});
    });
  }
  if(a==='api-copy-endpoint') return copyText(location.origin+'/v1/messages','接口地址已复制');
  if(a==='toggle'){
    var cur=el.getAttribute('aria-checked')==='true';
    return act(function(){return api('/api/pool/'+encodeURIComponent(name),{method:'PATCH',body:JSON.stringify({enabled:!cur})})});
  }
  if(a==='w+'||a==='w-'){
    var acc=state.pool.accounts.filter(function(x){return x.name===name})[0];
    var w=Math.max(1,Math.min(20,(acc?acc.weight:1)+(a==='w+'?1:-1)));
    return act(function(){return api('/api/pool/'+encodeURIComponent(name),{method:'PATCH',body:JSON.stringify({weight:w})})});
  }
  if(a==='reset'){
    return act(function(){
      return api('/api/pool/'+encodeURIComponent(name)+'/action',{method:'POST',body:JSON.stringify({action:'reset'})})
        .then(function(){toast('已重置 '+name)});
    });
  }
  if(a==='test'){
    el.disabled=true;
    return act(function(){
      return api('/api/pool/'+encodeURIComponent(name)+'/action',{method:'POST',body:JSON.stringify({action:'test'})})
        .then(function(j){ toast(j.message||((j.result&&j.result.ok)?'可用':'失败'), !(j.result&&j.result.ok)); });
    }).then(function(){el.disabled=false});
  }
  if(a==='login') return openLogin(name);
  if(a==='budget') return openBudget(name);
  if(a==='remove'){
    if(!confirm('删除账号「'+name+'」？其本地凭证目录也会一并删除，需要重新扫码。')) return;
    return act(function(){return api('/api/pool/'+encodeURIComponent(name),{method:'DELETE'}).then(function(){toast('已删除 '+name)})});
  }
});

$('strategy').addEventListener('change',function(ev){
  var v=ev.target.value;
  act(function(){
    return api('/api/pool',{method:'PATCH',body:JSON.stringify({strategy:v})}).then(function(){toast('策略已切换')});
  });
});
$('btn-refresh').addEventListener('click',load);
$('btn-add').addEventListener('click',openAdd);

/* 图表悬浮提示 */
function hideTip(){ $('tip').className='tip' }
$('chart').addEventListener('mousemove',function(e){
  var hit=e.target.closest('rect.hit');
  if(!hit) return hideTip();
  var i=Number(hit.getAttribute('data-i'));
  var p=state.stats.series[i];
  if(!p) return hideTip();
  var tip=$('tip');
  var label=state.stats.granularity==='hour'?mmdd(p.ts)+' '+hhmm(p.ts):p.ts.slice(5);
  tip.innerHTML='<b>'+label+'</b><br/>'+
    num(p.tokens)+' tokens · '+int(p.req)+' 次<br/>'+
    '成功 '+int(p.ok)+' · 失败 '+int(p.fail)+'<br/>'+
    '吞吐 '+(p.throughput||0).toFixed(1)+' tok/s';
  tip.className='tip on';
  var box=$('chart').getBoundingClientRect();
  var x=e.clientX-box.left, y=e.clientY-box.top;
  tip.style.left=Math.max(6,Math.min(box.width-150,x-70))+'px';
  tip.style.top=Math.max(6,y-86)+'px';
});
$('chart').addEventListener('mouseleave',hideTip);
$('chart').addEventListener('mouseover',function(){state.hover=true});
$('chart').addEventListener('mouseout',function(){state.hover=false});

/* ------------------------------------------------------------ 弹窗 */
function closeModal(){
  $('mask').className='mask';
  $('modal').innerHTML='';
  clearInterval(loginPoll);
}

function copyText(text,okMessage){
  var done=function(){toast(okMessage||'已复制')};
  if(navigator.clipboard&&navigator.clipboard.writeText){
    return navigator.clipboard.writeText(text).then(done).catch(function(){toast('复制失败，请手动选择',true)});
  }
  var input=document.createElement('textarea');
  input.value=text; input.style.position='fixed'; input.style.opacity='0';
  document.body.appendChild(input); input.select();
  var ok=document.execCommand('copy');
  input.remove();
  ok?done():toast('复制失败，请手动选择',true);
}

function openApiKey(key){
  $('mask').className='mask on';
  $('modal').innerHTML='<h2>客户端 Key 已生成</h2>'+
    '<p>用于 Anthropic SDK 的 <code>apiKey</code> 或 <code>Authorization: Bearer</code>。关闭后将无法再次查看明文。</p>'+
    '<div class="key-secret"><input id="new-api-key" type="password" readonly value="'+String(key).replace(/"/g,'&quot;')+'"/>'+
    '<button id="toggle-api-key">显示</button><button id="copy-api-key">复制</button></div>'+
    '<p class="key-warning">请像密码一样保管。服务端只保留摘要，无法帮你找回这个 Key。</p>'+
    '<div class="row"><button class="primary" data-x="close">我已保存</button></div>';
  var input=$('new-api-key');
  $('toggle-api-key').onclick=function(){
    input.type=input.type==='password'?'text':'password';
    this.textContent=input.type==='password'?'显示':'隐藏';
  };
  $('copy-api-key').onclick=function(){ copyText(input.value,'客户端 Key 已复制') };
  $('modal').querySelector('[data-x=close]').onclick=closeModal;
  input.focus(); input.select();
}
$('mask').addEventListener('click',function(e){ if(e.target===$('mask')) closeModal() });

function openAdd(){
  $('mask').className='mask on';
  $('modal').innerHTML='<h2>添加账号</h2><p>每个账号有独立的凭证目录，扫码后互不影响。</p>'+
    '<input id="new-name" placeholder="账号名，例如 alice 或 work" autocomplete="off"/>'+
    '<div class="row"><button data-x="close">取消</button><button class="primary" id="do-add">开始扫码</button></div>';
  $('new-name').focus();
  $('new-name').addEventListener('keydown',function(e){ if(e.key==='Enter') $('do-add').click() });
  $('do-add').onclick=function(){
    var name=($('new-name').value||'').trim();
    if(!name) return toast('请输入账号名',true);
    api('/api/pool',{method:'POST',body:JSON.stringify({name:name})})
      .then(function(){ openLogin(name) })
      .catch(function(e){ toast(e.message,true) });
  };
  $('modal').querySelector('[data-x=close]').onclick=closeModal;
}

function openBudget(name){
  var acc=state.pool.accounts.filter(function(x){return x.name===name})[0]||{};
  var cur=acc.budgetTokens||0;
  $('mask').className='mask on';
  $('modal').innerHTML='<h2>每日预算 · '+name+'</h2>'+
    '<p>按 token 计。填 0 表示不限额，此时只显示用量、不做额度拦截。超过预算的账号会自动停派，直到次日重置。</p>'+
    '<input id="budget" type="number" min="0" step="1000" value="'+cur+'" placeholder="例如 120000"/>'+
    '<div class="row"><button data-x="close">取消</button><button class="primary" id="do-budget">保存</button></div>';
  var input=$('budget');
  input.focus(); input.select();
  $('modal').querySelector('[data-x=close]').onclick=closeModal;
  $('do-budget').onclick=function(){
    var v=Math.max(0,Math.round(Number(input.value||0)));
    act(function(){
      return api('/api/pool/'+encodeURIComponent(name),{method:'PATCH',body:JSON.stringify({budgetTokens:v})})
        .then(function(){ closeModal(); toast(v?('预算已设为 '+num(v)+' tokens'):'已取消预算限制') });
    });
  };
}

function openLogin(name){
  $('mask').className='mask on';
  $('modal').innerHTML='<h2>扫码登录 · '+name+'</h2><p>用 WorkBuddy / 微信扫码，授权后会自动关闭。</p>'+
    '<div class="qrbox"><div style="padding:40px;text-align:center;color:#6b7280;font-size:13px">正在启动登录流程…</div></div>'+
    '<div class="row"><button data-x="close">关闭</button></div>';
  $('modal').querySelector('[data-x=close]').onclick=closeModal;

  api('/api/pool/'+encodeURIComponent(name)+'/action',{method:'POST',body:JSON.stringify({action:'login'})})
    .then(function(j){
      var sid=j.sessionId;
      $('modal').querySelector('.qrbox').innerHTML='<iframe src="/login/'+sid+'?embed=1"></iframe>';
      clearInterval(loginPoll);
      loginPoll=setInterval(function(){
        api('/api/status/'+sid).then(function(r){
          var st=r.session&&r.session.status;
          if(st==='authorized'||st==='already_logged_in'){
            clearInterval(loginPoll); toast('✓ '+name+' 已登录'); closeModal(); load();
          }else if(st==='failed'||st==='timeout'||st==='cancelled'){
            clearInterval(loginPoll); toast('登录未完成：'+st,true);
          }
        }).catch(function(){});
      },1500);
    })
    .catch(function(e){ toast('启动登录失败：'+e.message,true) });
}

/* 冷却倒计时，不触发网络请求 */
setInterval(function(){
  document.querySelectorAll('.cd[data-until]').forEach(function(el){
    var left=Number(el.getAttribute('data-until'))-Date.now();
    if(left<=0){ el.textContent='冷却结束'; return }
    el.textContent='冷却剩余 '+Math.ceil(left/1000)+'s';
  });
},1000);

load();
timer=setInterval(function(){
  if(document.hidden) return;
  if($('mask').className.indexOf('on')>=0) return;
  if(state.hover) return;
  load();
},5000);
</script>
</body></html>`;
}
