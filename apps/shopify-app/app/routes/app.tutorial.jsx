import { authenticate } from '../shopify.server'
import AnnotatedScreenshot from '../components/AnnotatedScreenshot'
import { TUTORIAL_STEPS } from '../tutorialSteps'

export const loader = async ({ request }) => {
  await authenticate.admin(request)
  return null
}

export default function TutorialPage() {
  return (
    <s-page heading="Tutorial">
      {TUTORIAL_STEPS.map((step) => (
        <s-section key={step.id} heading={step.title}>
          <s-stack direction="block" gap="base">
            <s-paragraph>{step.intro}</s-paragraph>
            <AnnotatedScreenshot {...step.image} marks={step.marks} />
          </s-stack>
        </s-section>
      ))}
      <s-section heading="Troubleshooting">
        <s-paragraph>
          Fit, a missing button or a blocked camera: see <s-link href="/app/additional">Help</s-link>.
        </s-paragraph>
      </s-section>
    </s-page>
  )
}
