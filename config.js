/*
 * CONFIGURAÇÃO DA CONEXÃO COM O SUPABASE
 *
 * Deixando os dois campos vazios, o sistema roda em MODO DEMONSTRAÇÃO:
 * tudo funciona, mas os pedidos ficam salvos só no navegador (serve para testar e mostrar).
 *
 * Para usar de verdade: no Supabase, vá em Project Settings > API (ou "API Keys")
 * e cole aqui a "Project URL" e a chave pública ("anon public" ou "publishable").
 *
 * ATENÇÃO: nunca coloque aqui a chave "service_role" / "secret".
 */
window.PIZZARIA_CONFIG = {
  SUPABASE_URL: 'https://unzjpvqdvzfmbourmwkn.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVuempwdnFkdnpmbWJvdXJtd2tuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4MzE0OTIsImV4cCI6MjEwODQwNzQ5Mn0.746SExIljzYYb-P-3hr9trN-pigoB1THHYg2dvx-oi8'
};
