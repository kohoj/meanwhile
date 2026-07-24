// Bun bundles CSS imported for side effects; declare it so tsc accepts the import.
declare module "*.css";
declare module "*.png" {
  const url: string;
  export default url;
}
