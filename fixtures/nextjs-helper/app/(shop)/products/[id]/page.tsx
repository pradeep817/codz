export default function ProductPage({ params }: { params: { id: string } }) {
  return <main>Product {params.id}</main>;
}
