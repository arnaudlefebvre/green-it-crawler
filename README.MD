
npm i -D playwright yaml
npx playwright install --with-deps
Renseigne config.yml (login en option via variables d’env KPI_USER/KPI_PASS).

node greenit-kpi-runner.js --config config.yml --out out

node greenit-kpi-runner-v3.9.7.js --config config.yml --out out --compare-latest


# 1) Lancer la capture et se connecter manuellement
node capture-session.js \
  --url "https://services.integration.santeclair.fr/pu/mysanteclair" \
  --out "out/auth/storageState.json" \
  --ignore-https-errors

# Optionnel : attendre un sélecteur présent après login (ex: #app-root)
node capture-session.js \
  --url "https://services.integration.santeclair.fr/pu/mysanteclair" \
  --out "out/auth/storageState.json" \
  --wait-selector "#app-root"

# Optionnel : attendre qu'une sous-chaîne soit dans l'URL après login
node capture-session.js \
  --url "https://services.integration.santeclair.fr/pu/mysanteclair" \
  --out "out/auth/storageState.json" \
  --wait-url-contains "/mysanteclair/tableau-de-bord"
  
#Comparer 2 exécutions
node kpi-compare.js \
  --base out/reports/MonProduit/MonProduit_RUN_2025-09-16T...json \
  --head out/reports/MonProduit/MonProduit_RUN_2025-09-17T...json \
  --out  out/reports/MonProduit
  
node kpi-compare.js   --base out/reports/MySanteClair_Web/MySanteClair_Web_RUN_2025-09-17T14-19-41-079Z.json \
  --head out/reports/MySanteClair_Web/MySanteClair_Web_RUN_2025-09-17T14-17-36-596Z.json \
  --out out/reports/MySanteClair_Web