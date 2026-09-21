// Account bearer persistence. The worker issues 30-day sessions, so the
// bearer belongs in localStorage (survives browser restarts), not
// sessionStorage. The expiry timestamp is stored beside the token and the
// pair is cleared the first time an expired token is loaded.
const ACCOUNT_TOKEN_KEY='doxomachy-account',ACCOUNT_TOKEN_EXP_KEY='doxomachy-account-expires';
function saveAccountToken(token,expiresInSeconds){try{localStorage.setItem(ACCOUNT_TOKEN_KEY,token);localStorage.setItem(ACCOUNT_TOKEN_EXP_KEY,String(Date.now()+Number(expiresInSeconds||0)*1000))}catch{}}
function loadAccountToken(){try{const t=localStorage.getItem(ACCOUNT_TOKEN_KEY)||'';if(!t)return '';const e=Number(localStorage.getItem(ACCOUNT_TOKEN_EXP_KEY)||0);if(e&&Date.now()>e){clearAccountToken();return ''}return t}catch{return ''}}
function clearAccountToken(){try{localStorage.removeItem(ACCOUNT_TOKEN_KEY);localStorage.removeItem(ACCOUNT_TOKEN_EXP_KEY)}catch{}}
