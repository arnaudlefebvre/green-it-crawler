# 🌱 Green IT KPI Crawler

Un outil d'analyse automatisé pour mesurer l'impact environnemental et les performances web de vos applications, basé sur les métriques GreenIT et RWEB.

## 🎯 Objectifs du projet

Ce projet permet d'**automatiser l'audit environnemental** de vos sites web en mesurant :

- **📊 Métriques techniques** : requêtes, taille DOM, compression, minification, cache, etc.
- **🌍 Impact environnemental** : émissions CO₂, consommation d'énergie et d'eau (mix énergétique français)
- **⚡ Performance web** : lazy loading, formats d'images optimisés, protocoles HTTP
- **🔒 Sécurité** : HSTS, cookies, domaines externes

### Pourquoi c'est important ?

- **Réduction de l'empreinte carbone** : Chaque Ko économisé réduit les émissions CO₂
- **Conformité réglementaire** : Anticipation des futures réglementations environnementales
- **Performance utilisateur** : Sites plus rapides = meilleure UX
- **Coûts d'infrastructure** : Moins de bande passante = économies
- **Image de marque** : Engagement environnemental visible

## 🚀 Installation

### Prérequis
- Node.js 18+ 
- npm ou yarn

### Installation des dépendances

```bash
# Cloner le projet
git clone <repository-url>
cd green-it-crawler

# Installer les dépendances
npm install

# Installer les navigateurs Playwright
npx playwright install --with-deps
```

## ⚙️ Configuration

Créez un fichier `config.yml` à la racine du projet :

### Configuration basique

```yaml
# Configuration minimale
targets:
- product: "Mon Site Web"
  pages:
  - name: "Accueil"
    url: "https://monsite.com"
  - name: "À propos"
    url: "https://monsite.com/about"

# Configuration runtime
runtime:
  headless: true
  ignoreHTTPSErrors: false
  navigationTimeoutMs: 60000
  settleAfterMs: 2500

# Impact environnemental (mix énergétique français)
impact:
  kWhPerGB: 0.81
  gridIntensity_g_per_kWh: 79    # France: 79g CO₂/kWh
  waterIntensity_L_per_kWh: 0.8  # France: 0.8L/kWh
```

### Configuration avancée avec authentification

```yaml
# Configuration avec login automatique
login:
  url: "https://monsite.com/login"
  usernameSelector: "#username"
  passwordSelector: "#password"
  submitSelector: "button[type=submit]"
  usernameEnv: "SITE_USER"      # Variable d'environnement
  passwordEnv: "SITE_PASS"      # Variable d'environnement
  waitFor: "networkidle"
  timeoutMs: 45000

# Ou utiliser une session capturée
login:
  storageStatePath: "out/auth/storageState.json"

targets:
- product: "Application Privée"
  pages:
  # Pages publiques (pas d'auth requise)
  - name: "Landing"
    url: "https://app.com/landing"
  
  # Pages privées (auth requise)
  - name: "Dashboard"
    url: "https://app.com/dashboard"
    auth: "required"
    weight: 2  # Poids plus important pour le calcul global
  
  - name: "Profile"
    url: "https://app.com/profile"
    requiresAuth: true

# Configuration KPI avec impact environnemental
kpi:
  weights:
    # Métriques traditionnelles (90%)
    requests: 0.35
    transferKB: 0.20
    domSize: 0.15
    uniqueDomains: 0.08
    compressedPct: 0.04
    minifiedPct: 0.04
    
    # Impact environnemental (10%)
    co2Impact: 0.04      # CO₂ (le plus important)
    energyImpact: 0.03   # Énergie
    waterImpact: 0.02    # Eau
    dataImpact: 0.01     # Volume de données
    
    # Autres métriques
    inlineStyles: 0.02
    inlineScripts: 0.02
    cssFiles: 0.015
    jsFiles: 0.015
    # ... autres poids

  thresholds:
    # Seuils environnementaux (contexte français)
    co2_g: [0.5, 1.0, 2.0, 4.0]           # g CO₂ par page
    energy_kWh: [0.0006, 0.0012, 0.0025, 0.005]  # kWh par page
    water_cl: [0.05, 0.1, 0.2, 0.4]       # cL par page
    dataGB: [0.0005, 0.001, 0.002, 0.004] # GB transférés
    
    # Seuils traditionnels
    requests: [27, 50, 80, 120]
    transferKB: [300, 800, 1500, 2500]
    domSize: [800, 1500, 2500, 4000]
    # ... autres seuils

  # Poids par page (optionnel)
  page_weights:
    "Mon Site Web":
      "Accueil": 3      # Page d'accueil plus importante
      "À propos": 1
    "Dashboard": 2      # Ou directement par nom de page

# Configuration cache
cache:
  minSeconds: 604800  # 7 jours minimum pour les assets statiques
```

### Configuration multi-produits

```yaml
targets:
- product: "Site Public"
  pages:
  - name: "Accueil"
    url: "https://public.monsite.com"

- product: "Application Métier"
  login:
    url: "https://app.monsite.com/login"
    usernameSelector: "#email"
    passwordSelector: "#password"
    submitSelector: ".login-btn"
    usernameEnv: "APP_USER"
    passwordEnv: "APP_PASS"
  pages:
  - name: "Dashboard"
    url: "https://app.monsite.com/dashboard"
    auth: "required"

- product: "API Documentation"
  pages:
  - name: "API Docs"
    url: "https://docs.monsite.com"
```

## 🏃‍♂️ Utilisation

### Commandes principales

```bash
# Analyse basique
npm run kpi

# Analyse avec session persistante
npm run kpi:session

# Version modulaire (recommandée)
npm run kpi:modular

# Avec paramètres personnalisés
node src/main.js --config config.yml --out results

# Comparaison automatique avec la dernière exécution
node src/main.js --config config.yml --out results --compare-latest
```

### Variables d'environnement pour l'authentification

```bash
# Définir les credentials (ne jamais les committer !)
export SITE_USER="mon.email@example.com"
export SITE_PASS="monmotdepasse"

# Ou dans un fichier .env (à ajouter au .gitignore)
echo "SITE_USER=mon.email@example.com" >> .env
echo "SITE_PASS=monmotdepasse" >> .env

# Puis lancer l'analyse
npm run kpi:modular
```

## 🔐 Gestion de l'authentification

### Méthode 1 : Login automatique (form-fill) (recommandée)

Configuration dans `config.yml` :

```yaml
login:
  url: "https://monsite.com/login"
  usernameSelector: "#username"           # Sélecteur CSS du champ email/username
  passwordSelector: "#password"           # Sélecteur CSS du champ password
  submitSelector: "button[type=submit]"   # Sélecteur CSS du bouton de connexion
  usernameEnv: "SITE_USER"               # Variable d'environnement pour l'username
  passwordEnv: "SITE_PASS"               # Variable d'environnement pour le password
  waitFor: "networkidle"                 # Attendre la fin des requêtes réseau
  timeoutMs: 45000                       # Timeout en millisecondes

# Pour des sélecteurs complexes (Shadow DOM, frameworks comme Vaadin)
login:
  url: "https://app.com/login"
  usernameSelectors:                     # Plusieurs sélecteurs possibles
    - "#username"
    - "css=vaadin-text-field[name='username'] >>> input"
  passwordSelectors:
    - "#password"  
    - "css=vaadin-password-field[name='password'] >>> input"
  submitSelector: "vaadin-button[theme='primary']"
```

### Méthode 2 : Capture de session manuelle 

Plus fiable pour les authentifications complexes (2FA, CAPTCHA, etc.) :

```bash
# 1. Capturer une session en se connectant manuellement
npm run session:capture

# Ou avec paramètres personnalisés
node capture-session.js \
  --url "https://monsite.com/login" \
  --out "out/auth/storageState.json" \
  --ignore-https-errors

# Optionnel : attendre un élément spécifique après login
node capture-session.js \
  --url "https://monsite.com/login" \
  --out "out/auth/storageState.json" \
  --wait-selector "#dashboard"

# Optionnel : attendre une URL spécifique
node capture-session.js \
  --url "https://monsite.com/login" \
  --out "out/auth/storageState.json" \
  --wait-url-contains "/dashboard"
```

Puis dans `config.yml` :

```yaml
login:
  storageStatePath: "out/auth/storageState.json"
```

### Méthode 3 : Authentification par produit

Chaque produit peut avoir sa propre authentification :

```yaml
targets:
- product: "MySanteClair Web"
  login:
    storageStatePath: "out/auth/mysanteclair_storageState.json"
  pages:
  - name: "Dashboard"
    url: "https://services.santeclair.fr/dashboard"
    auth: "required"

- product: "Santeclair Solution"  
  login:
    url: "https://solution.santeclair.fr/login"
    usernameEnv: "STC_USER"
    passwordEnv: "STC_PASS"
    usernameSelector: "#email"
    passwordSelector: "#password"
    submitSelector: ".btn-login"
  pages:
  - name: "Admin"
    url: "https://solution.santeclair.fr/admin"
    requiresAuth: true
```

Les variables d'environnement suivent le pattern : `{PREFIX}_{PRODUCT}_USER` et `{PREFIX}_{PRODUCT}_PASS`

## 📊 Résultats et rapports

### Structure des fichiers générés

```
out/
├── reports/
│   └── MonSiteWeb/
│       ├── MonSiteWeb_Accueil_2025-09-18T12-34-56-789Z_report.md
│       ├── MonSiteWeb_GLOBAL_2025-09-18T12-34-56-789Z.md
│       ├── MonSiteWeb_RUN_2025-09-18T12-34-56-789Z.json
│       └── DIFF_MonSiteWeb_RUN_...vs_RUN_....md
├── pages/
│   └── MonSiteWeb_Accueil_2025-09-18T12-34-56-789Z.html
├── logs/
│   ├── MonSiteWeb_Accueil_2025-09-18T12-34-56-789Z_responses.json
│   └── MonSiteWeb_Accueil_2025-09-18T12-34-56-789Z_jserrors.json
├── auth/
│   └── storageState.json
├── history.jsonl
└── history.csv
```

### Types de rapports

1. **Rapport détaillé par page** (`*_report.md`) :
   - Grade environnemental et KPI composite
   - Impact CO₂, énergie, eau avec équivalences
   - Métriques techniques détaillées
   - Conseils d'amélioration par indicateur
   - Liste des ressources problématiques

2. **Rapport global par produit** (`*_GLOBAL_*.md`) :
   - Score global pondéré
   - Synthèse par page
   - Méthode de calcul

3. **Comparaisons** (`DIFF_*.md`) :
   - Évolution des scores entre deux exécutions
   - Régressions et améliorations
   - Changements d'impact environnemental

## 🔄 Comparaison d'exécutions

```bash
# Comparaison automatique avec la dernière exécution
node src/main.js --config config.yml --out out --compare-latest

# Comparaison manuelle entre deux exécutions spécifiques
node kpi-compare.cjs \
  --base out/reports/MonProduit/MonProduit_RUN_2025-09-16T....json \
  --head out/reports/MonProduit/MonProduit_RUN_2025-09-17T....json \
  --out out/reports/MonProduit
```

## 🛠️ Développement

### Architecture modulaire

Le projet utilise une architecture modulaire pour faciliter la maintenance :

```
src/
├── crawler/          # Navigation et collecte de données
├── kpi/             # Calcul des métriques et scores
├── reporting/       # Génération des rapports
├── utils/           # Utilitaires partagés
└── main.js          # Orchestrateur principal
```

### Scripts de développement

```bash
# Version originale (stable)
npm run kpi

# Version modulaire (développement)
npm run kpi:modular

# Tests et validation
npm run kpi:modular -- --config config-test.yml
```

## 📈 Métriques mesurées

### Impact environnemental (mix français)
- **CO₂** : 79g CO₂eq/kWh (vs 442g mondial)
- **Énergie** : Consommation en kWh
- **Eau** : 0.8L/kWh (efficacité nucléaire)
- **Données** : Volume transféré

### Métriques techniques
- Nombre de requêtes HTTP
- Taille des pages (transféré vs décodé)
- Taille du DOM
- Compression et minification
- Cache et cookies
- Formats d'images optimisés
- Lazy loading
- Sécurité (HSTS)

### Scores et grades
- **KPI composite** : 0-100 avec grade A-G
- **Grade environnemental** : A+ à F
- **Pondération configurable** par métrique
- **Seuils adaptés** au contexte français

## 🤝 Contribution

1. Fork le projet
2. Créer une branche feature (`git checkout -b feature/amelioration`)
3. Commit les changements (`git commit -am 'Ajout fonctionnalité'`)
4. Push vers la branche (`git push origin feature/amelioration`)
5. Créer une Pull Request

## 📄 Licence

Ce projet est sous licence [Apache2](LICENSE).

## 🆘 Support

- **Issues** : Signaler les bugs via GitHub Issues
- **Documentation** : Voir `src/README.md` pour l'architecture technique
- **Configuration** : Exemples dans `config-environmental-example.yml`